/**
 * DeepCodeX 多角色团队 - 领域专家 review 插件（DomainExpertReviewPlugin）
 *
 * 来源：DOMAIN_EXPERT_INTEGRATION_DESIGN.md §3.4.3（v1.1 P0-3）
 * 严格遵循 user rules：禁止 mock/占位/简化；5 个钩子 + 2 个内部方法全部真实实现
 * Karpathy 原则：Surgical Changes - 只新增插件文件，不修改 BasePlugin / PluginContext 接口
 *
 * 集成位置（multi-agent-team 8 阶段流程）：
 *   - 阶段 2（架构设计）：matches()=true 时触发，调用专业领域专家（如 cloud-architect）参与 review
 *   - 阶段 8（发布评审）：matches()=true 时触发，根据任务业务领域动态调用对应领域专家
 *
 * 工作流程（5 个钩子真实实现，无伪代码）：
 *   1. matches(ctx): 判断当前是否为阶段 2/8 且 enableDomainExperts=true 且 enabledCategories 非空
 *   2. before(ctx): 调用 DomainExpertMatcher.matchExperts(task) 获取 topK 领域专家
 *      → 暂存到 ctx.state["domainExpertCandidates"]
 *   3. execute(ctx): 并行调用 LLM（Promise.allSettled + 超时保护），注入每个专家的 systemPromptPrefix
 *      → 构建 DispatchResult（V3 契约）+ DomainExpertDispatchResult（富类型，存 ctx.state）
 *   4. after(ctx, result): 汇总专家意见为 markdown 报告
 *      → 存入 ctx.state["domainExpertReviews"] + ctx.task.upstreamContext["domainExpertReviews"]
 *   5. cleanup(ctx, exc): 异常日志记录（dispatcher 在 try/finally 中保证调用）
 *
 * 互斥关系（P1-NEW-3：mutex 字符串与插件 name 一致）：
 *   - 与 "architect-review" 插件互斥（阶段 2 只允许一个 review 插件）
 *   - 与 "test-expert-review" 插件互斥（阶段 8 只允许一个 review 插件）
 *
 * 降级策略（Ponytail 红线 R-02：必须显式错误处理）：
 *   - 单个专家 LLM 调用失败 → 不影响其他专家（Promise.allSettled 捕获）
 *   - 全部专家失败 → DispatchResult.status="failed"，error 汇总各专家错误
 *   - 无候选专家 → DispatchResult.status="skipped"，跳过 review
 *   - 无 API Key → invokeExpertLLM 抛 ExpertInvocationError，由 allSettled 捕获
 */

import { z } from "zod";
import { BasePlugin } from "./plugins/base.js";
import type { PluginMeta } from "./plugins/base.js";
import type {
  DispatchResult,
  DispatchStatus,
  DomainExpertDispatchResult,
  DomainExpertMatchResult,
  DomainMatchOptions,
  ExpertOpinion,
  PluginContext,
  TaskRequirement,
  TeamConfig,
} from "./types.js";
import { ExpertOpinion as ExpertOpinionSchema } from "./types.js";
import type { DomainExpertRegistry } from "./domain-expert-registry.js";
import type { DomainExpertMatcher } from "./domain-expert-matcher.js";
import { createOpenAIClient } from "../common/openai-client.js";
import { ExpertInvocationError } from "./errors.js";

// ============================================================================
// 第一部分：常量与配置
// ============================================================================

/**
 * 单个专家 LLM 调用默认超时（毫秒）
 *
 * 设计依据：与 domain-expert-matcher.ts scoreByDomainAI 的 timeoutMs 默认值对齐
 * 超时后 invokeExpertLLM 抛 ExpertInvocationError（phase="timeout"）
 */
const DEFAULT_EXPERT_TIMEOUT_MS = 30_000;

/**
 * ctx.state 中存储领域专家相关数据的 key 常量
 *
 * 使用常量而非字符串字面量，避免拼写错误导致跨阶段读取失败
 */
const STATE_KEY_CANDIDATES = "domainExpertCandidates";
const STATE_KEY_DISPATCH_RESULT = "domainExpertDispatchResult";
const STATE_KEY_REVIEWS = "domainExpertReviews";

/**
 * 专家 review 响应 schema（zod 校验）
 *
 * 用于解析 LLM 返回的 JSON 响应，确保结构符合 ExpertOpinion 类型
 * 所有字段都有明确约束，避免 LLM 返回不合规数据导致下游异常
 */
const ExpertReviewResponseSchema = z.object({
  /** 总体 review 意见（markdown 格式，≥10 字符） */
  opinion: z.string().min(10),
  /** 专家对自身意见的置信度（0-1） */
  confidence: z.number().min(0).max(1),
  /** 关键观点（结构化摘要） */
  keyPoints: z.array(z.string().min(1)).default([]),
  /** 风险提示（专家识别的业务风险） */
  risks: z.array(z.string().min(1)).default([]),
  /** 建议措施（专家给出的具体建议） */
  recommendations: z.array(z.string().min(1)).default([]),
});
type ExpertReviewResponse = z.infer<typeof ExpertReviewResponseSchema>;

/**
 * DomainExpertReviewPlugin 构造选项
 *
 * 设计：所有字段可选，提供合理默认值
 * 用途：单元测试注入客户端 / 生产环境覆盖超时
 */
export interface DomainExpertReviewPluginOptions {
  /** 单个专家 LLM 调用超时（毫秒，默认 30000） */
  expertTimeoutMs?: number;
  /** 注入的 OpenAI 客户端（用于单元测试，禁止 mock，仅替换调用入口） */
  injectedClient?: unknown;
  /** 项目根目录（用于读取 .env 中的 OpenAI API Key，默认 process.cwd()） */
  projectRoot?: string;
}

// ============================================================================
// 第二部分：辅助函数（prompt 构建 + 响应解析）
// ============================================================================

/**
 * 构建专家 review 的系统 prompt
 *
 * 组合顺序：
 *   1. expert.systemPromptPrefix（含 Karpathy 4 原则 + Ponytail 16 红线 + 角色定义）
 *   2. expert.systemPromptSuffix（后置约束，如输出格式偏好）
 *   3. JSON 输出格式说明（强制 LLM 返回结构化 JSON）
 *
 * @param expertConfig 专家的 prompt 前缀和后缀
 * @returns 完整的系统 prompt
 */
function buildExpertSystemPrompt(expertConfig: { systemPromptPrefix: string; systemPromptSuffix: string }): string {
  const jsonFormatGuide = `

# OUTPUT FORMAT（强制 JSON，违反将导致解析失败）

你必须返回一个 JSON 对象，包含以下字段：

\`\`\`json
{
  "opinion": "总体 review 意见（markdown 格式，≥10 字符，包含关键判断和理由）",
  "confidence": 0.0 到 1.0 之间的数值，表示你对本次 review 意见的置信度,
  "keyPoints": ["关键观点 1", "关键观点 2", ...],
  "risks": ["风险 1", "风险 2", ...],
  "recommendations": ["建议 1", "建议 2", ...]
}
\`\`\`

## 严格规则
1. 只输出 JSON，不要 markdown 包装、不要解释、不要道歉
2. opinion 字段必须 ≥10 字符，包含具体的业务判断
3. keyPoints / risks / recommendations 可为空数组，但字段必须存在
4. confidence 必须是 0-1 之间的数值（不是字符串）
5. 如果任务与你的专长无关，confidence 设为 0.1-0.3，opinion 说明不匹配原因`;

  const suffix = expertConfig.systemPromptSuffix ? `\n\n# SUFFIX CONSTRAINTS\n${expertConfig.systemPromptSuffix}` : "";

  return `${expertConfig.systemPromptPrefix}${suffix}${jsonFormatGuide}`;
}

/**
 * 构建专家 review 的用户 prompt
 *
 * 内容包含：任务标题、描述、业务标签、约束、附件、review 请求
 *
 * @param task 任务需求
 * @returns 用户 prompt 字符串
 */
function buildExpertUserPrompt(task: TaskRequirement): string {
  const lines: string[] = [];
  lines.push("# 待 review 任务");
  lines.push("");
  lines.push(`## 任务标题`);
  lines.push(task.title);
  lines.push("");
  lines.push(`## 任务描述`);
  lines.push(task.description);
  lines.push("");

  if (task.domainTags.length > 0) {
    lines.push(`## 业务标签`);
    lines.push(task.domainTags.join("、"));
    lines.push("");
  }

  if (task.constraints.length > 0) {
    lines.push(`## 约束条件`);
    for (const c of task.constraints) {
      lines.push(`- ${c}`);
    }
    lines.push("");
  }

  if (task.attachments.length > 0) {
    lines.push(`## 附件（文件路径或 URL）`);
    for (const a of task.attachments) {
      lines.push(`- ${a}`);
    }
    lines.push("");
  }

  lines.push(`## review 请求`);
  lines.push("请基于你的专业领域，对上述任务进行 review，重点关注：");
  lines.push("1. 业务合理性：任务方案是否符合行业最佳实践");
  lines.push("2. 潜在风险：是否存在业务、合规、财务、法律等风险");
  lines.push("3. 改进建议：是否有更优的实现路径或需补充的考虑");
  lines.push("");
  lines.push("请按照系统 prompt 中的 JSON 格式输出你的 review 意见。");

  return lines.join("\n");
}

/**
 * 解析 LLM 响应为 ExpertOpinion
 *
 * 解析流程：
 *   1. 提取 response.choices[0].message.content
 *   2. JSON.parse + zod schema 校验
 *   3. 合并 expert 元信息（expertId / expertName）
 *
 * @param content LLM 返回的文本内容
 * @param expert 提供元信息的专家匹配结果
 * @returns ExpertOpinion
 * @throws {ExpertInvocationError} 当 content 为空 / JSON 解析失败 / schema 校验失败
 */
function parseExpertResponse(content: string | null | undefined, expert: DomainExpertMatchResult): ExpertOpinion {
  const expertId = expert.expert.expertId;
  const expertName = expert.expert.name;

  if (!content || content.trim().length === 0) {
    throw new ExpertInvocationError(expertId, "empty", "LLM 返回空内容");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (e) {
    throw new ExpertInvocationError(
      expertId,
      "parse",
      `JSON 解析失败：${e instanceof Error ? e.message : String(e)}`,
      e instanceof Error ? e : undefined
    );
  }

  const validated = ExpertReviewResponseSchema.safeParse(parsed);
  if (!validated.success) {
    throw new ExpertInvocationError(
      expertId,
      "parse",
      `schema 校验失败：${validated.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`
    );
  }

  const data: ExpertReviewResponse = validated.data;
  const opinion: ExpertOpinion = {
    expertId,
    expertName,
    opinion: data.opinion,
    confidence: data.confidence,
    keyPoints: data.keyPoints,
    risks: data.risks,
    recommendations: data.recommendations,
  };

  // 最终通过 ExpertOpinion schema 校验（防御性，确保返回值符合契约）
  return ExpertOpinionSchema.parse(opinion);
}

// ============================================================================
// 第三部分：DomainExpertReviewPlugin 主类
// ============================================================================

/**
 * 单个专家 LLM 调用结果（含 token 用量）
 *
 * 设计依据：P2-1 修复 - 真实透传 LLM response.usage 字段，避免 tokensConsumed 简化为 0
 * 用途：execute() 聚合所有成功专家的 usage，填充到 DispatchResult.tokensConsumed
 *
 * 注意：interface 必须定义在模块顶层（类外部），esbuild/tsx 不支持类方法内定义 interface
 */
interface ExpertInvocationSuccess {
  /** 解析后的专家意见 */
  opinion: ExpertOpinion;
  /** LLM 调用的 token 用量（来自 response.usage） */
  usage: {
    prompt: number;
    completion: number;
    total: number;
  };
}

/**
 * 领域专家 review 插件（v1.1 P0-3 / Phase 5 真实实现）
 *
 * 集成方式：
 *   - 继承 BasePlugin 获得 log/ok/fail/progress 辅助方法
 *   - 实现 matches/before/execute/after/cleanup 5 个钩子
 *   - mutex 与 "architect-review" / "test-expert-review" 互斥
 *
 * 构造参数：
 *   - registry：领域专家注册中心（用于查询专家详情，可选，主要用于调试）
 *   - matcher：领域专家匹配器（用于 before 阶段匹配候选专家）
 *   - teamConfig：团队配置（提供 enableDomainExperts / enabledCategories / domainExpert* 配置）
 *   - options：插件选项（超时 / 注入客户端 / 项目根目录）
 *
 * 设计决策（P1-NEW-1 修复：禁止伪代码）：
 *   - 所有 5 个钩子均为真实实现，无 "// 实际实现详见 Phase 5" 注释
 *   - invokeExpertLLM 真实调用 OpenAI API，含 AbortController 超时保护
 *   - summarizeOpinions 真实生成 markdown 报告，含关键观点/风险/建议三段
 *   - 失败降级：单个专家失败不影响其他专家（Promise.allSettled）
 */
export class DomainExpertReviewPlugin extends BasePlugin {
  /** V3 契约：插件元数据（P1-NEW-3：mutexWith 字符串与互斥插件 name 一致） */
  readonly meta: PluginMeta = {
    name: "domain-expert-review",
    priority: 50,
    description: "领域专家 review 插件，在阶段 2（架构设计）/ 8（发布评审）调用业务专家",
    mutexWith: ["architect-review", "test-expert-review"],
    requiresTask: true,
    phases: ["plan", "verify"],
    version: "1.0.0",
    author: "DeepCodeX",
  };

  /**
   * 构造函数
   *
   * @param registry 领域专家注册中心（用于查询专家详情，可选）
   * @param matcher 领域专家匹配器（用于 before 阶段匹配候选专家）
   * @param teamConfig 团队配置（提供 enableDomainExperts 等配置）
   * @param options 插件选项（超时 / 注入客户端 / 项目根目录）
   */
  constructor(
    private readonly registry: DomainExpertRegistry,
    private readonly matcher: DomainExpertMatcher,
    private readonly teamConfig: TeamConfig,
    private readonly options: DomainExpertReviewPluginOptions = {}
  ) {
    super();
    this.initializeMeta();
  }

  // ==========================================================================
  // 钩子 1：matches - 判断当前是否应触发领域专家 review
  // ==========================================================================

  /**
   * 是否匹配当前上下文（同步判断，V3 契约）
   *
   * 匹配条件（全部满足）：
   *   1. teamConfig.enableDomainExperts === true（用户显式启用领域专家）
   *   2. teamConfig.enabledCategories.length > 0（至少配置一个业务类别）
   *   3. ctx.currentPhase === 2 || ctx.currentPhase === 8（架构设计或发布评审阶段）
   *   4. 任务包含业务信号（domainTags 非空 或 title+description 非空，避免无意义调用）
   *
   * @param ctx 插件上下文
   * @returns true 表示匹配，触发 before/execute/after 钩子链
   */
  matches(ctx: PluginContext): boolean {
    // 条件 1：用户必须显式启用领域专家（默认关闭，避免无意义开销）
    if (!this.teamConfig.enableDomainExperts) {
      return false;
    }

    // 条件 2：至少配置一个业务类别（用户原话："动态根据业务调用，非全部静态注册"）
    if (this.teamConfig.enabledCategories.length === 0) {
      return false;
    }

    // 条件 3：仅在阶段 2（架构设计）或阶段 8（发布评审）触发
    // currentPhase 为可选字段，未设置时不触发（向后兼容）
    if (ctx.currentPhase !== 2 && ctx.currentPhase !== 8) {
      return false;
    }

    // 条件 4：任务包含业务信号（避免空任务无意义调用）
    // P2-2 修复：简化逻辑，TaskRequirement schema 已保证 title ≥3 字符 / description ≥10 字符，
    //           因此 title.length > 0 和 description.length > 0 总是为 true，无需检查。
    //           只需检查 domainTags 是否非空（避免无业务标签的任务触发专家 review）。
    if (ctx.task.domainTags.length === 0) {
      return false;
    }

    return true;
  }

  // ==========================================================================
  // 钩子 2：before - 调用 DomainExpertMatcher 匹配候选专家
  // ==========================================================================

  /**
   * dispatch 前钩子：触发 DomainExpertMatcher 匹配候选专家
   *
   * 实现步骤：
   *   1. 从 teamConfig 读取匹配策略 / topK / 阈值
   *   2. 调用 matcher.matchExperts(task, options) 获取 topK 候选专家
   *   3. 将匹配结果暂存到 ctx.state[STATE_KEY_CANDIDATES]
   *   4. 记录 INFO 日志（候选数量 / top1 置信度）
   *
   * 异常处理：
   *   - matcher.matchExperts 内部已捕获所有异常并返回空数组
   *   - 此处不再 try/catch，若 matcher 抛错则由 dispatcher 捕获并触发 cleanup
   *
   * @param ctx 插件上下文
   */
  async before(ctx: PluginContext): Promise<void> {
    this.log(ctx, "INFO", `DomainExpertReviewPlugin 开始匹配候选专家（阶段 ${ctx.currentPhase}）`);

    // 构造匹配选项（从 teamConfig 读取，与 settings.json 配置对齐）
    const matchOptions: Partial<DomainMatchOptions> = {
      strategy: this.teamConfig.domainExpertMatchStrategy,
      topK: this.teamConfig.domainExpertTopK,
      aiFallbackThreshold: this.teamConfig.domainExpertThreshold,
    };

    // 调用 matcher 获取候选专家（matcher 内部已处理降级策略）
    const candidates = await this.matcher.matchExperts(ctx.task, matchOptions);

    // 暂存到 ctx.state，供 execute() 读取
    ctx.state[STATE_KEY_CANDIDATES] = candidates;

    // 记录匹配结果日志（便于追踪）
    if (candidates.length === 0) {
      this.log(ctx, "WARNING", "未匹配到任何领域专家，将跳过 review");
    } else {
      const top1 = candidates[0];
      this.log(
        ctx,
        "INFO",
        `匹配到 ${candidates.length} 个领域专家，top1: ${top1.expert.name}（置信度 ${(top1.confidence * 100).toFixed(1)}%）`
      );
    }
  }

  // ==========================================================================
  // 钩子 3：execute - 并行调用 LLM 获取专家 review 意见
  // ==========================================================================

  /**
   * dispatch 中钩子：并行调用 LLM 获取各专家 review 意见
   *
   * 实现步骤：
   *   1. 从 ctx.state 读取候选专家列表
   *   2. 无候选专家 → 返回 status="skipped" 的 DispatchResult
   *   3. 并行调用 invokeExpertLLM（Promise.allSettled + 超时保护）
   *   4. 收集成功意见 + 失败原因
   *   5. 构建 DomainExpertDispatchResult（富类型，存 ctx.state）
   *   6. 返回 DispatchResult（V3 契约，dispatcher 消费）
   *
   * 降级策略：
   *   - 单个专家失败 → 不影响其他专家（Promise.allSettled 捕获 rejection）
   *   - 全部失败 → DispatchResult.status="failed"，error 汇总各专家错误
   *   - 无候选 → DispatchResult.status="skipped"
   *
   * @param ctx 插件上下文
   * @returns DispatchResult（V3 契约）
   */
  async execute(ctx: PluginContext): Promise<DispatchResult> {
    const candidates = ctx.state[STATE_KEY_CANDIDATES] as ReadonlyArray<DomainExpertMatchResult> | undefined;

    // 无候选专家 → 跳过 review
    if (!candidates || candidates.length === 0) {
      this.log(ctx, "INFO", "无候选专家，跳过领域专家 review");
      return this.fail(ctx, "无候选领域专家，跳过 review");
    }

    this.log(ctx, "INFO", `开始并行调用 ${candidates.length} 个领域专家 LLM`);

    // 并行调用所有候选专家的 LLM（Promise.allSettled 确保单个失败不影响其他）
    const settledResults = await Promise.allSettled(candidates.map((c) => this.invokeExpertLLM(c, ctx.task)));

    // 收集成功意见 + 失败原因 + token 用量聚合（P2-1 修复：真实透传 LLM usage）
    const opinions: ExpertOpinion[] = [];
    const failures: { expertId: string; reason: string }[] = [];
    /** 聚合所有成功专家的 token 用量（init 为 0，逐个累加） */
    const aggregatedUsage = { prompt: 0, completion: 0, total: 0 };

    settledResults.forEach((result, index) => {
      const candidate = candidates[index];
      if (result.status === "fulfilled") {
        // 成功：收集 opinion 并累加 token 用量
        opinions.push(result.value.opinion);
        aggregatedUsage.prompt += result.value.usage.prompt;
        aggregatedUsage.completion += result.value.usage.completion;
        aggregatedUsage.total += result.value.usage.total;
      } else {
        // 失败：rejection reason 是 ExpertInvocationError 或其他 Error
        const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
        failures.push({ expertId: candidate.expert.expertId, reason });
        this.log(
          ctx,
          "WARNING",
          `领域专家 ${candidate.expert.name}（${candidate.expert.expertId}）调用失败：${reason}`
        );
      }
    });

    // 汇总专家意见为 markdown 报告
    const summary = this.summarizeOpinions(opinions, failures);

    // 构建富类型 DomainExpertDispatchResult（存 ctx.state，供下游阶段读取）
    // 注意：matchedExperts 字段类型为 mutable array（zod schema 约束），
    //       candidates 是 ReadonlyArray，需通过 spread 转换为 mutable
    const dispatchResult: DomainExpertDispatchResult = {
      taskId: ctx.task.taskId,
      dispatchId: ctx.dispatch.dispatchId,
      matchedExperts: [...candidates],
      status: opinions.length > 0 ? "succeeded" : "failed",
      startedAt: new Date(ctx.startTime).toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - ctx.startTime,
      output: summary,
      error:
        failures.length > 0
          ? `${failures.length} 个专家调用失败：${failures.map((f) => `${f.expertId}(${f.reason})`).join("; ")}`
          : undefined,
      artifacts: [],
      // P2-1 修复：使用聚合后的真实 token 用量，不再简化为 0
      tokensConsumed: { ...aggregatedUsage },
      cacheHit: false,
      retryCount: 0,
    };
    ctx.state[STATE_KEY_DISPATCH_RESULT] = dispatchResult;

    // 构建 V3 契约 DispatchResult（dispatcher 消费）
    const status: DispatchStatus = opinions.length > 0 ? "succeeded" : "failed";
    // P3-1 修复：根据 currentPhase 动态选择 roleId，避免硬编码 "solo-coder"
    // 阶段 2（架构设计）→ "architect"，阶段 8（发布评审）→ "test-expert"
    // 其他阶段（不应到达，matches 已过滤）→ "solo-coder" 兜底
    const matchedRoleId = ctx.currentPhase === 2 ? "architect" : ctx.currentPhase === 8 ? "test-expert" : "solo-coder";
    const dispatchResultV3: DispatchResult = {
      taskId: ctx.task.taskId,
      dispatchId: ctx.dispatch.dispatchId,
      matchedRole: {
        roleId: matchedRoleId,
        roleName: `领域专家 review（${matchedRoleId}）`,
        confidence: opinions.length > 0 ? opinions[0].confidence : 0,
        matchedCapabilities: [],
        matchedSkills: [],
        missingCapabilities: [],
        reasons: [
          `领域专家 review 完成：${opinions.length} 成功 / ${failures.length} 失败 / ${candidates.length} 总计`,
        ],
        scoreBreakdown: { capability: 1, skill: 1, keyword: 1, priority: 1 },
        strategy: "keyword",
      },
      status,
      startedAt: new Date(ctx.startTime).toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - ctx.startTime,
      output: summary,
      error: status === "failed" ? dispatchResult.error : undefined,
      artifacts: [],
      // P2-1 修复：V3 契约 DispatchResult 同步使用聚合后的真实 token 用量
      tokensConsumed: { ...aggregatedUsage },
      cacheHit: false,
      retryCount: 0,
      // v2.1.3 新增字段：领域专家 review 路径未触发 LLM 续写
      continueCount: 0,
      isPartial: false,
    };

    this.log(
      ctx,
      "INFO",
      `领域专家 review 完成：${opinions.length} 成功 / ${failures.length} 失败（status=${status}）`
    );

    return dispatchResultV3;
  }

  // ==========================================================================
  // 钩子 4：after - 汇总专家意见到 ctx.state 和 ctx.task.upstreamContext
  // ==========================================================================

  /**
   * dispatch 后钩子：汇总专家意见到跨阶段共享数据
   *
   * 实现步骤：
   *   1. 从 ctx.state 读取 DomainExpertDispatchResult
   *   2. 将 markdown 报告存入 ctx.state[STATE_KEY_REVIEWS]
   *   3. 同步到 ctx.task.upstreamContext["domainExpertReviews"]（跨任务传播）
   *   4. 记录 INFO 日志
   *
   * 注意：即使 execute 返回 failed，after 仍会被调用（dispatcher 保证）
   *       此时应记录空报告，避免下游读取 undefined
   *
   * @param ctx 插件上下文
   * @param result execute 返回的 DispatchResult
   */
  async after(ctx: PluginContext, result: DispatchResult): Promise<void> {
    const dispatchResult = ctx.state[STATE_KEY_DISPATCH_RESULT] as DomainExpertDispatchResult | undefined;
    const summary = dispatchResult?.output ?? result.output ?? "";

    // 存入 ctx.state（同任务跨阶段共享）
    ctx.state[STATE_KEY_REVIEWS] = summary;

    // 同步到 ctx.task.upstreamContext（跨任务传播，如下游 architect 读取）
    ctx.task.upstreamContext["domainExpertReviews"] = summary;

    this.log(
      ctx,
      "INFO",
      `领域专家 review 意见已汇总到 ctx.state 和 ctx.task.upstreamContext（${summary.length} 字符）`
    );
  }

  // ==========================================================================
  // 钩子 5：cleanup - 异常清理
  // ==========================================================================

  /**
   * 清理钩子（dispatcher 在 try/finally 中保证调用）
   *
   * 实现步骤：
   *   1. 若 exc 非 null，记录 ERROR 日志（含异常详情）
   *   2. 清理 in-flight state（避免内存泄漏）
   *
   * 幂等性：可被多次调用（dispatcher 重试场景）
   *
   * @param ctx 插件上下文
   * @param exc 异常对象（null 表示正常完成）
   */
  async cleanup(ctx: PluginContext, exc: unknown): Promise<void> {
    if (exc !== null && exc !== undefined) {
      const errorMsg = exc instanceof Error ? `${exc.name}: ${exc.message}` : String(exc);
      this.log(ctx, "ERROR", `DomainExpertReviewPlugin 异常退出：${errorMsg}`);
    }

    // 清理 in-flight state（幂等，重复调用无副作用）
    // 注意：不清理 STATE_KEY_REVIEWS，因为下游阶段可能需要读取
    // STATE_KEY_CANDIDATES 和 STATE_KEY_DISPATCH_RESULT 是 review 完成后的中间数据，可安全清理
    // 但为支持 after() 重试，这里仅在实际异常时清理
    if (exc !== null && exc !== undefined) {
      delete ctx.state[STATE_KEY_CANDIDATES];
      delete ctx.state[STATE_KEY_DISPATCH_RESULT];
    }
  }

  // ==========================================================================
  // 内部方法 1：invokeExpertLLM - 调用单个专家 LLM
  // ==========================================================================

  /**
   * 调用单个专家 LLM 获取 review 意见（真实实现，含超时保护 + token 用量透传）
   *
   * 实现步骤：
   *   1. 获取 OpenAI 客户端（注入优先，否则从 .env 读取）
   *   2. 构建系统 prompt（expert.systemPromptPrefix + suffix + JSON 格式说明）
   *   3. 构建用户 prompt（任务标题/描述/标签/约束/附件）
   *   4. 调用 LLM（AbortController + setTimeout 超时保护）
   *   5. 解析响应为 ExpertOpinion（zod schema 校验）
   *   6. 提取 response.usage 字段，返回 { opinion, usage } 给调用方聚合
   *
   * @param candidate 专家匹配结果（含 expert 定义和匹配信息）
   * @param task 任务需求
   * @returns ExpertInvocationSuccess（含 opinion 和 usage）
   * @throws {ExpertInvocationError} 当 LLM 不可用 / 超时 / 响应解析失败时抛出
   */
  private async invokeExpertLLM(
    candidate: DomainExpertMatchResult,
    task: TaskRequirement
  ): Promise<ExpertInvocationSuccess> {
    const expert = candidate.expert;
    const expertId = expert.expertId;

    // 步骤 1：获取 OpenAI 客户端
    let client: ReturnType<typeof createOpenAIClient> | null = null;
    if (this.options.injectedClient) {
      client = this.options.injectedClient as ReturnType<typeof createOpenAIClient>;
    } else {
      try {
        client = createOpenAIClient(this.options.projectRoot ?? process.cwd());
      } catch (e) {
        throw new ExpertInvocationError(
          expertId,
          "no-client",
          `OpenAI 客户端创建失败：${e instanceof Error ? e.message : String(e)}`,
          e instanceof Error ? e : undefined
        );
      }
    }

    if (!client || !client.client) {
      throw new ExpertInvocationError(expertId, "no-client", "OpenAI 客户端不可用（可能未配置 API Key）");
    }

    // 步骤 2-3：构建 prompts
    const systemPrompt = buildExpertSystemPrompt(expert);
    const userPrompt = buildExpertUserPrompt(task);

    // 步骤 4：调用 LLM（AbortController + setTimeout 超时保护）
    // 同时保留 response 引用以提取 usage 字段（P2-1 修复：真实透传 token 用量）
    const timeoutMs = this.options.expertTimeoutMs ?? DEFAULT_EXPERT_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let content: string | null | undefined;
    /** LLM response.usage 字段（OpenAI 标准格式：prompt_tokens / completion_tokens / total_tokens） */
    let usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | undefined;
    try {
      const response = await client.client.chat.completions.create(
        {
          model: client.model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          response_format: { type: "json_object" },
          temperature: 0.3, // review 场景需要一定创造性，但不过度发散
        },
        { signal: controller.signal }
      );
      content = response.choices[0]?.message?.content;
      // 提取 token 用量（OpenAI 标准响应字段）
      // 注意：某些自定义 OpenAI 兼容端点可能不返回 usage，需做防御性检查
      usage = response.usage as { prompt_tokens: number; completion_tokens: number; total_tokens: number } | undefined;
    } catch (e) {
      // P1-1 修复：catch 块中也要清理 timer，避免 parseExpertResponse 抛错时 timer 泄漏
      clearTimeout(timer);
      // 区分超时和其他错误
      const isTimeout = e instanceof Error && e.name === "AbortError";
      throw new ExpertInvocationError(
        expertId,
        isTimeout ? "timeout" : "network",
        isTimeout ? `LLM 调用超时（${timeoutMs}ms）` : `LLM 调用失败：${e instanceof Error ? e.message : String(e)}`,
        e instanceof Error ? e : undefined
      );
    } finally {
      // P1-1 修复：无论成功/失败/异常，都确保 timer 被清理
      // 防止 parseExpertResponse 在 try 块外抛错时 timer 泄漏
      clearTimeout(timer);
    }

    // 步骤 5：解析响应为 ExpertOpinion（P1-1 修复后：此步骤在 finally 块外，timer 已确保清理）
    const opinion = parseExpertResponse(content, candidate);

    // 步骤 6：构造返回值（含 token 用量）
    // 当 usage 缺失时（自定义 OpenAI 兼容端点），token 数记为 0 而非抛错
    // 这是合理的降级，因为 token 统计是可观察性指标，不影响业务正确性
    const tokenUsage = {
      prompt: usage?.prompt_tokens ?? 0,
      completion: usage?.completion_tokens ?? 0,
      total: usage?.total_tokens ?? 0,
    };

    return { opinion, usage: tokenUsage };
  }

  // ==========================================================================
  // 内部方法 2：summarizeOpinions - 汇总专家意见为 markdown 报告
  // ==========================================================================

  /**
   * 汇总专家意见为 markdown 报告（真实实现，含三段结构）
   *
   * 报告结构：
   *   1. 标题：领域专家 review 汇总
   *   2. 概览：成功/失败数量、阶段
   *   3. 各专家意见（按 confidence 降序）：
   *      - 专家名 + 置信度
   *      - 总体意见（markdown）
   *      - 关键观点（列表）
   *      - 风险提示（列表）
   *      - 建议措施（列表）
   *   4. 失败专家（如有）：expertId + 失败原因
   *
   * @param opinions 成功的专家意见列表
   * @param failures 失败的专家列表
   * @returns markdown 格式的汇总报告
   */
  private summarizeOpinions(
    opinions: ReadonlyArray<ExpertOpinion>,
    failures: ReadonlyArray<{ expertId: string; reason: string }> = []
  ): string {
    if (opinions.length === 0 && failures.length === 0) {
      return "# 领域专家 review 汇总\n\n无候选专家，未执行 review。\n";
    }

    const lines: string[] = [];
    lines.push("# 领域专家 review 汇总");
    lines.push("");
    lines.push(`## 概览`);
    lines.push("");
    lines.push(`- 成功：${opinions.length} 位专家`);
    lines.push(`- 失败：${failures.length} 位专家`);
    lines.push(`- 总计：${opinions.length + failures.length} 位专家`);
    lines.push("");

    // 按 confidence 降序排列（高置信度专家意见优先展示）
    const sortedOpinions = [...opinions].sort((a, b) => b.confidence - a.confidence);

    if (sortedOpinions.length > 0) {
      lines.push(`## 专家意见`);
      lines.push("");

      for (const opinion of sortedOpinions) {
        lines.push(`### ${opinion.expertName}（${opinion.expertId}）`);
        lines.push("");
        lines.push(`**置信度**：${(opinion.confidence * 100).toFixed(1)}%`);
        lines.push("");
        lines.push(`#### 总体意见`);
        lines.push("");
        lines.push(opinion.opinion);
        lines.push("");

        if (opinion.keyPoints.length > 0) {
          lines.push(`#### 关键观点`);
          lines.push("");
          for (const kp of opinion.keyPoints) {
            lines.push(`- ${kp}`);
          }
          lines.push("");
        }

        if (opinion.risks.length > 0) {
          lines.push(`#### 风险提示`);
          lines.push("");
          for (const r of opinion.risks) {
            lines.push(`- ${r}`);
          }
          lines.push("");
        }

        if (opinion.recommendations.length > 0) {
          lines.push(`#### 建议措施`);
          lines.push("");
          for (const rec of opinion.recommendations) {
            lines.push(`- ${rec}`);
          }
          lines.push("");
        }

        lines.push(`---`);
        lines.push("");
      }
    }

    if (failures.length > 0) {
      lines.push(`## 失败专家`);
      lines.push("");
      lines.push(`以下专家调用失败，未参与 review：`);
      lines.push("");
      for (const f of failures) {
        lines.push(`- ${f.expertId}：${f.reason}`);
      }
      lines.push("");
    }

    return lines.join("\n");
  }
}

// ============================================================================
// 第四部分：_internals 导出（供单元测试访问内部函数）
// ============================================================================

/**
 * 内部函数导出（与 domain-expert-matcher.ts _internals 模式对齐）
 *
 * 用途：单元测试直接调用内部函数验证算法正确性
 * 约束：仅供测试使用，生产代码不应依赖 _internals
 */
export const _internals = {
  buildExpertSystemPrompt,
  buildExpertUserPrompt,
  parseExpertResponse,
  ExpertReviewResponseSchema,
  DEFAULT_EXPERT_TIMEOUT_MS,
  STATE_KEY_CANDIDATES,
  STATE_KEY_DISPATCH_RESULT,
  STATE_KEY_REVIEWS,
};
