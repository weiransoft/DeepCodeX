/**
 * DeepCodeX 多角色团队 - 适配层
 *
 * 作用：将 team 模块的纯函数与 deepcode-cli 的 Session / Settings / Tools 集成
 * 严格遵循 user rules：禁止 mock；所有集成点必须真实连接 deepcode-cli 现有组件
 * Karpathy 原则：Surgical Changes - 仅做最小必要集成
 *
 * 集成点：
 *   1. Settings：team.enabled / team.matchStrategy 等从 settings.json 读取
 *   2. Session：注入角色 system prompt 到 LLM 调用
 *   3. Tools：dispatcher 调度后调用 ToolExecutor 执行实际工具
 *   4. Prompt：getSystemPrompt 增强为多角色版
 */

import { z } from "zod";
import * as path from "path";
import * as fs from "fs";
// v1.6 P0-2：引入 createOpenAIClient + OpenAIClientHandle 用于 executeDispatch 真实 LLM 调用
import { createOpenAIClient, type OpenAIClientHandle, isOpenAIClientHandle } from "../common/openai-client.js";
// v1.6 P1-1：引入 buildThinkingRequestOptions 用于在 executeDispatch 中传递 thinking 参数
// 修复点：之前 executeDispatch 构造 LLM 请求体时未传 thinking / reasoning_effort 参数，
// 即使 settings.json 设置 thinkingEnabled=true，API 端也不会启用 thinking 模式。
// 通过 buildThinkingRequestOptions 与 session.ts 主对话流程保持一致的请求语义。
import { buildThinkingRequestOptions } from "../common/openai-thinking.js";
import type { ReasoningEffort } from "../settings.js";
import { matchRoles, matchRolesSync, type MatchOptions } from "./role-matcher.js";
import { ROLE_MAP, getRole, ROLE_REGISTRY } from "./role-registry.js";
import type {
  DispatchResult,
  DispatchStatus,
  MatchResult,
  RoleDefinition,
  RoleId,
  TaskRequirement,
  TeamConfig,
} from "./types.js";
import { TeamConfig as TeamConfigSchema } from "./types.js";

// ============================================================================
// 第一部分：配置加载
// ============================================================================

/**
 * 从 settings.json 中读取 team.* 配置
 *
 * 设计：
 *   - 兼容 settings.json 已存在的 team 字段
 *   - 未配置时使用 TeamConfig 默认值
 *   - zod 校验失败时记录日志并降级到默认配置
 */
export function loadTeamConfig(projectRoot: string = process.cwd()): TeamConfig {
  let raw: Record<string, unknown> = {};
  try {
    const settingsPath = path.join(projectRoot, ".deepcode", "settings.json");
    if (fs.existsSync(settingsPath)) {
      const content = fs.readFileSync(settingsPath, "utf-8");
      const parsed = JSON.parse(content);
      if (parsed && typeof parsed === "object" && "team" in parsed) {
        raw = (parsed as { team: Record<string, unknown> }).team;
      }
    }
  } catch (_err) {
    // 读取失败 → 使用默认配置
    raw = {};
  }
  const validated = TeamConfigSchema.safeParse(raw);
  if (!validated.success) {
    return TeamConfigSchema.parse({});
  }
  return validated.data;
}

// ============================================================================
// 第二部分：Task 构造器
// ============================================================================

/**
 * TaskRequirement 构造器（适配层最常用的入口）
 *
 * @param params 简单参数
 * @returns 完整的 TaskRequirement
 */
export function buildTask(params: {
  title: string;
  description: string;
  requiredCapabilities?: string[];
  preferredSkills?: string[];
  constraints?: string[];
  attachments?: string[];
  upstreamContext?: Record<string, unknown>;
  priority?: "low" | "medium" | "high" | "critical";
  timeoutMs?: number;
  /** v1.1 新增：业务领域标签（可选，默认空数组，用于 DomainExpertMatcher 匹配） */
  domainTags?: string[];
}): TaskRequirement {
  return {
    taskId: crypto.randomUUID(),
    title: params.title,
    description: params.description,
    requiredCapabilities: params.requiredCapabilities ?? [],
    preferredSkills: params.preferredSkills ?? [],
    constraints: params.constraints ?? [],
    attachments: params.attachments ?? [],
    upstreamContext: params.upstreamContext ?? {},
    priority: params.priority ?? "medium",
    timeoutMs: params.timeoutMs ?? 0,
    createdAt: new Date().toISOString(),
    // v1.1 新增：业务领域标签默认空数组（与 TaskRequirement schema default 对齐）
    domainTags: params.domainTags ?? [],
  };
}

// ============================================================================
// 第三部分：核心调度入口
// ============================================================================

/**
 * 调度选项（zod 校验）
 *
 * v1.6 P0-2 扩展：
 *   - timeoutMs：LLM 调用超时（毫秒），超时后 abort
 *   - injectedClient：注入的 OpenAI 客户端句柄（测试专用，避免真实 API 调用）
 */
export const DispatchOptions = z.object({
  projectRoot: z.string().default(process.cwd()),
  // 强制使用指定角色（跳过匹配）
  forceRole: z
    .object({
      roleId: z.string(),
      reason: z.string().optional(),
    })
    .optional(),
  // 覆盖 team 配置
  configOverride: z
    .object({
      matchStrategy: z.enum(["keyword", "ai", "hybrid"]).optional(),
      topK: z.number().int().positive().optional(),
      aiFallbackThreshold: z.number().min(0).max(1).optional(),
    })
    .optional(),
  // 是否同时返回多角色结果（用于多角色共识）
  multiRole: z.boolean().default(false),
  // v1.6 P0-2：LLM 调用超时（毫秒），undefined 表示不超时
  timeoutMs: z.number().int().positive().optional(),
  // v1.6 P0-2：注入的 OpenAI 客户端句柄（测试专用）
  // 使用 z.unknown() 因为 zod 无法直接校验类实例，运行时通过 isOpenAIClientHandle 守卫
  injectedClient: z.unknown().optional(),
  /**
   * 最大续写次数（v2.1.3 新增）
   *
   * 含义：LLM 输出被 maxTokens 截断（finish_reason="length"）时，自动发送续写请求的最大次数
   * - 0 = 禁用续写（截断后直接返回部分输出，isPartial=true）
   * - 3 = 默认值，最多续写 3 次（总输出可达 4 × maxTokens）
   * - 10 = 上限，防止无限循环
   *
   * 用途：企业应用代码生成等长输出场景，避免因 maxTokens 限制导致代码截断
   */
  maxContinueCount: z.number().int().min(0).max(10).optional(),
});
export type DispatchOptions = z.infer<typeof DispatchOptions>;

/**
 * 调度返回结果（含匹配信息和派生的 system prompt）
 */
export interface TeamDispatchResult {
  // 任务
  task: TaskRequirement;
  // 匹配结果（按 confidence 降序）
  matches: ReadonlyArray<MatchResult>;
  // 推荐角色（confidence 最高者）
  recommendedRole: RoleDefinition;
  // 推荐角色的 system prompt（完整，可直接喂给 LLM）
  recommendedSystemPrompt: string;
  // 是否启用了 AI 增强
  aiEnhanced: boolean;
  // 团队配置
  teamConfig: TeamConfig;
  // 派生的 dispatchId
  dispatchId: string;
  // 状态
  status: DispatchStatus;
  // 时间戳
  startedAt: string;
}

/**
 * 核心调度函数（不执行实际任务，仅做角色匹配和 prompt 构造）
 *
 * 与 DeepCodeX 现有 dispatch 流程集成：
 *   1. 加载 team 配置
 *   2. 构造 TaskRequirement
 *   3. 调用 matchRoles 匹配角色
 *   4. 取 top1 作为 recommendedRole
 *   5. 拼接角色 system prompt + base system prompt
 *
 * @param task 任务需求或简单参数
 * @param options 调度选项
 * @returns 调度结果（含 system prompt）
 */
export async function dispatchToRole(
  task: TaskRequirement | Parameters<typeof buildTask>[0],
  options?: Partial<DispatchOptions>
): Promise<TeamDispatchResult> {
  const opts = DispatchOptions.parse(options ?? {});
  const teamConfig = loadTeamConfig(opts.projectRoot);

  // 如果 team 未启用 → 使用 solo-coder 默认
  if (!teamConfig.enabled) {
    const defaultTask: TaskRequirement =
      "title" in task && "requiredCapabilities" in task ? (task as TaskRequirement) : buildTask(task);
    return {
      task: defaultTask,
      matches: [],
      recommendedRole: getRole(teamConfig.defaultRole),
      recommendedSystemPrompt: getRole(teamConfig.defaultRole).systemPromptPrefix,
      aiEnhanced: false,
      teamConfig,
      dispatchId: crypto.randomUUID(),
      status: "pending",
      startedAt: new Date().toISOString(),
    };
  }

  // 统一通过 buildTask 构造，确保所有数组字段被初始化为 []
  const fullTask: TaskRequirement =
    "title" in task && "requiredCapabilities" in task ? (task as TaskRequirement) : buildTask(task);

  // 角色匹配
  const matchOpts: Partial<MatchOptions> = {
    strategy: opts.configOverride?.matchStrategy ?? teamConfig.matchStrategy,
    topK: opts.configOverride?.topK ?? teamConfig.topK,
    aiFallbackThreshold: opts.configOverride?.aiFallbackThreshold ?? teamConfig.aiFallbackThreshold,
    projectRoot: opts.projectRoot,
  };

  let matches: ReadonlyArray<MatchResult>;
  let aiEnhanced = false;
  if (opts.forceRole) {
    // 强制角色模式
    const role = ROLE_MAP.get(opts.forceRole.roleId as RoleId);
    if (!role) {
      throw new Error(`强制角色不存在: ${opts.forceRole.roleId}`);
    }
    matches = [
      {
        roleId: role.roleId,
        roleName: role.name,
        confidence: 1.0,
        matchedCapabilities: role.capabilities,
        matchedSkills: role.skills,
        missingCapabilities: [],
        reasons: opts.forceRole.reason ? [`强制指定: ${opts.forceRole.reason}`] : ["强制指定角色"],
        scoreBreakdown: {
          capability: 1.0,
          skill: 1.0,
          keyword: 1.0,
          priority: 1.0,
        },
        strategy: "keyword",
      },
    ];
  } else {
    matches = await matchRoles(fullTask, matchOpts);
    // 判断是否真正使用了 AI 增强
    aiEnhanced = matches.some((m) => m.strategy !== "keyword" && m.scoreBreakdown.semantic !== undefined);
  }

  if (matches.length === 0) {
    throw new Error("未匹配到任何角色");
  }

  const top = matches[0]!;
  const recommendedRole = getRole(top.roleId);
  const recommendedSystemPrompt = composeSystemPrompt(recommendedRole, fullTask, opts.projectRoot);

  return {
    task: fullTask,
    matches,
    recommendedRole,
    recommendedSystemPrompt,
    aiEnhanced,
    teamConfig,
    dispatchId: crypto.randomUUID(),
    status: "pending",
    startedAt: new Date().toISOString(),
  };
}

/**
 * 同步版调度（仅 keyword 模式，用于 CLI 启动）
 */
export function dispatchToRoleSync(
  taskTitle: string,
  taskDescription: string,
  options?: Partial<DispatchOptions>
): TeamDispatchResult {
  const opts = DispatchOptions.parse(options ?? {});
  const teamConfig = loadTeamConfig(opts.projectRoot);

  if (!teamConfig.enabled) {
    const defaultRole = getRole(teamConfig.defaultRole);
    return {
      task: buildTask({ title: taskTitle, description: taskDescription }),
      matches: [],
      recommendedRole: defaultRole,
      recommendedSystemPrompt: defaultRole.systemPromptPrefix,
      aiEnhanced: false,
      teamConfig,
      dispatchId: crypto.randomUUID(),
      status: "pending",
      startedAt: new Date().toISOString(),
    };
  }

  const top = matchRolesSync(taskTitle, taskDescription);
  if (!top) {
    throw new Error("未匹配到任何角色");
  }
  const recommendedRole = getRole(top.roleId);
  const task = buildTask({ title: taskTitle, description: taskDescription });
  const systemPrompt = composeSystemPrompt(recommendedRole, task, opts.projectRoot);

  return {
    task,
    matches: [top],
    recommendedRole,
    recommendedSystemPrompt: systemPrompt,
    aiEnhanced: false,
    teamConfig,
    dispatchId: crypto.randomUUID(),
    status: "pending",
    startedAt: new Date().toISOString(),
  };
}

// ============================================================================
// 第四部分：System Prompt 增强
// ============================================================================

/**
 * 拼接完整 system prompt：角色 prompt + 任务上下文 + deepcode-cli 基础 prompt
 *
 * 拼接顺序（重要，前面的优先级更高）：
 *   1. 角色 systemPromptPrefix（含 Karpathy 4 原则 + Ponytail 16 红线）
 *   2. 角色 systemPromptSuffix
 *   3. 任务上下文（title/description/attachments/constraints）
 *   4. 多角色共识（如果 multiRole=true，附上其他候选角色信息）
 *   5. deepcode-cli 基础 system prompt
 */
export function composeSystemPrompt(role: RoleDefinition, task: TaskRequirement, projectRoot: string): string {
  const parts: string[] = [];

  // 1. 角色主 prompt
  parts.push(role.systemPromptPrefix);

  // 2. 角色后置 prompt（如有）
  if (role.systemPromptSuffix) {
    parts.push(`\n## 角色后置约束\n\n${role.systemPromptSuffix}\n`);
  }

  // 3. 任务上下文
  parts.push(`\n## 当前任务\n`);
  parts.push(`**标题**: ${task.title}\n\n`);
  parts.push(`**描述**:\n${task.description}\n`);
  if (task.requiredCapabilities.length > 0) {
    parts.push(`\n**所需能力**: ${task.requiredCapabilities.join(", ")}\n`);
  }
  if (task.preferredSkills.length > 0) {
    parts.push(`**偏好技能**: ${task.preferredSkills.join(", ")}\n`);
  }
  if (task.constraints.length > 0) {
    parts.push(`**约束条件**:\n${task.constraints.map((c) => `- ${c}`).join("\n")}\n`);
  }
  if (task.attachments.length > 0) {
    parts.push(`\n**附件**:\n${task.attachments.map((a) => `- ${a}`).join("\n")}\n`);
  }
  if (task.priority !== "medium") {
    parts.push(`\n**优先级**: ${task.priority}\n`);
  }

  // 4. 项目根目录信息
  parts.push(`\n## 项目根目录\n\n\`${projectRoot}\`\n`);

  return parts.join("");
}

// ============================================================================
// 第五部分：完整 dispatch 执行（带 tool execution）
// ============================================================================

/**
 * 从 TaskRequirement 构造结构化 user prompt
 *
 * v1.6 P0-2 新增：executeDispatch 调用 LLM 时使用的 user prompt
 *
 * 拼接内容：
 *   1. 任务标题
 *   2. 任务描述
 *   3. 所需能力 / 偏好技能 / 约束条件 / 附件
 *   4. 优先级
 *   5. upstreamContext（如有）
 *
 * 段标题格式：使用 `#` 一级标题（与 build-user-prompt.test.ts 期望对齐）
 *
 * @param task 任务需求
 * @returns 结构化 user prompt 字符串
 */
export function buildUserPromptFromTask(task: TaskRequirement): string {
  const parts: string[] = [];

  // 1. 任务标题
  parts.push(`# 任务标题\n\n${task.title}\n`);

  // 2. 任务描述
  parts.push(`# 任务描述\n\n${task.description}\n`);

  // 3. 所需能力
  if (task.requiredCapabilities.length > 0) {
    parts.push(`# 所需能力\n\n${task.requiredCapabilities.map((c) => `- ${c}`).join("\n")}\n`);
  }

  // 4. 偏好技能
  if (task.preferredSkills.length > 0) {
    parts.push(`# 偏好技能\n\n${task.preferredSkills.map((s) => `- ${s}`).join("\n")}\n`);
  }

  // 5. 约束条件
  if (task.constraints.length > 0) {
    parts.push(`# 约束条件\n\n${task.constraints.map((c) => `- ${c}`).join("\n")}\n`);
  }

  // 6. 附件
  if (task.attachments.length > 0) {
    parts.push(`# 附件\n\n${task.attachments.map((a) => `- ${a}`).join("\n")}\n`);
  }

  // 7. 优先级
  parts.push(`# 优先级\n\n${task.priority}\n`);

  // 8. upstreamContext（如有）
  const ctxKeys = Object.keys(task.upstreamContext);
  if (ctxKeys.length > 0) {
    parts.push(`# 上游上下文\n`);
    for (const key of ctxKeys) {
      const val = task.upstreamContext[key];
      parts.push(`${key}: ${typeof val === "object" ? JSON.stringify(val) : String(val)}`);
    }
    parts.push("");
  }

  return parts.join("\n");
}

/**
 * 完整 dispatch 执行（角色匹配 + LLM 调用 + 工具执行 + 结果收集）
 *
 * v1.6 P0-2 重写：
 *   - 阶段 3 实现真实 LLM 调用（injectedClient 优先 → createOpenAIClient 兜底）
 *   - 支持 timeoutMs 超时控制（通过 AbortController + signal）
 *   - signal 参数位置修复：从请求体移到 SDK 第二参数 `options`
 *   - 测试环境通过 injectedClient 注入 stub client，避免真实 API 调用
 *
 * @param task 任务
 * @param options 调度选项
 * @param onProgress 进度回调
 * @returns 完整 DispatchResult
 */
// ============================================================================
// v1.1 新增：LLM 主动停止+继续关键字检测
// ============================================================================

/**
 * 继续意图关键字列表（v1.1 新增）
 *
 * 当 LLM 输出末尾包含这些关键字时，表示 LLM 主动停止但仍有内容需要输出。
 * 检测范围：输出末尾 200 字符（避免正文中的"继续"误判）
 *
 * 设计依据：
 * - 实际 E2E 测试中 LLM 输出"由于输出较长,我将继续在下一条消息中完成..."
 * - 覆盖中英文常见表达方式
 */
const CONTINUE_INTENTION_KEYWORDS: readonly string[] = [
  "将继续",
  "继续在下一条消息",
  "继续输出",
  "请继续",
  "未完待续",
  "继续完成",
  "will continue",
  "continue in the next",
] as const;

/**
 * 检测 LLM 输出末尾是否包含继续意图关键字（v1.1 新增）
 *
 * 当 finish_reason="stop" 但输出末尾包含"将继续"等关键字时，
 * 表示 LLM 主动停止但仍有内容需要输出，应触发续写。
 *
 * @param content LLM 输出内容
 * @param tailLength 检测末尾字符数（默认 200）
 * @returns true 表示检测到继续意图，应触发续写
 */
export function detectContinueIntention(content: string, tailLength: number = 200): boolean {
  if (!content || content.length === 0) {
    return false;
  }
  // 取输出末尾 tailLength 字符作为检测范围
  const tail = content.length > tailLength ? content.slice(-tailLength) : content;
  // 转小写进行大小写不敏感匹配（覆盖英文关键字）
  const tailLower = tail.toLowerCase();
  // 子串匹配：任一关键字出现即认为有继续意图
  return CONTINUE_INTENTION_KEYWORDS.some((kw) => tailLower.includes(kw.toLowerCase()));
}

/**
 * 判断是否应该继续续写（v1.1 新增）
 *
 * 续写触发条件（满足任一即可）：
 * 1. finish_reason === "length"（输出被 maxTokens 截断）
 * 2. finish_reason === "stop" && detectContinueIntention(content)（LLM 主动停止但表示要继续）
 *
 * @param finishReason 当前响应的 finish_reason
 * @param content 当前累计的完整输出内容
 * @returns true 表示应该继续续写
 */
export function shouldContinue(finishReason: string | null, content: string): boolean {
  if (finishReason === "length") {
    return true;
  }
  if (finishReason === "stop" && detectContinueIntention(content)) {
    return true;
  }
  return false;
}

// ============================================================================
// 第五部分：完整 dispatch 执行（带 tool execution）
// ============================================================================

export async function executeDispatch(
  task: TaskRequirement,
  options: Partial<DispatchOptions> = {},
  onProgress?: (status: DispatchStatus, message: string) => void
): Promise<DispatchResult> {
  const dispatchId = crypto.randomUUID();
  const startedAt = new Date().toISOString();

  // 解析 options（zod 校验 + 默认值）
  const opts = DispatchOptions.parse(options);

  try {
    // ========================================================================
    // 阶段 1：角色调度（匹配角色 + 构造 system prompt）
    // ========================================================================
    onProgress?.("running", "正在匹配角色...");
    const teamResult = await dispatchToRole(task, options);
    const matchedRole = teamResult.matches[0] ?? {
      roleId: teamResult.recommendedRole.roleId,
      roleName: teamResult.recommendedRole.name,
      confidence: 0,
      matchedCapabilities: [],
      matchedSkills: [],
      missingCapabilities: [],
      reasons: ["无匹配结果"],
      scoreBreakdown: { capability: 0, skill: 0, keyword: 0, priority: 0 },
      strategy: "keyword" as const,
    };

    onProgress?.(
      "running",
      `已匹配角色: ${teamResult.recommendedRole.name} (${((matchedRole.confidence ?? 0) * 100) | 0}%)`
    );

    // ========================================================================
    // 阶段 2：准备 LLM 客户端（injectedClient 优先 → createOpenAIClient 兜底）
    // ========================================================================
    // injectedClient 优先：测试环境通过 stub client 注入
    // 生产环境：调用 createOpenAIClient()，若 settings.apiKey 为空则 client===null
    let clientHandle: OpenAIClientHandle | null = null;

    if (opts.injectedClient !== undefined) {
      // 校验 injectedClient 是否符合 OpenAIClientHandle 接口
      // v1.6 P0-2 修正（LL-009 / SH-016 / SH-017）：非法 injectedClient 不抛 Error，
      // 而是返回 status=skipped 的 DispatchResult，让上层 StageHandler.judgeResult
      // 在 skipped 分支统一判定为 fatal（避免 catch 块误将 status 设为 failed）
      // error 消息含 "不可用" 关键字，与 LL-004 测试期望对齐
      if (!isOpenAIClientHandle(opts.injectedClient)) {
        const skipResult: DispatchResult = {
          taskId: task.taskId,
          dispatchId,
          matchedRole,
          status: "skipped",
          startedAt,
          completedAt: new Date().toISOString(),
          durationMs: Date.now() - new Date(startedAt).getTime(),
          output: teamResult.recommendedSystemPrompt,
          artifacts: [],
          tokensConsumed: { prompt: 0, completion: 0, total: 0 },
          cacheHit: false,
          retryCount: 0,
          // v2.1.3 新增字段：skipped 状态下未触发续写
          continueCount: 0,
          isPartial: false,
          error: "注入的 LLM 客户端不可用（不符合 OpenAIClientHandle 接口），跳过 LLM 调用",
        };
        onProgress?.("skipped", "注入的 LLM 客户端不可用，跳过 LLM 调用");
        return skipResult;
      }
      clientHandle = opts.injectedClient;
    } else {
      // 生产环境：创建真实 OpenAI 客户端
      const created = createOpenAIClient(opts.projectRoot);
      if (created.client === null) {
        // API Key 缺失：返回 skipped 状态（不阻塞，由调用方决定如何处理）
        // v1.6 P0-2 修正（LL-004）：error 消息含 "不可用" 关键字
        const skipResult: DispatchResult = {
          taskId: task.taskId,
          dispatchId,
          matchedRole,
          status: "skipped",
          startedAt,
          completedAt: new Date().toISOString(),
          durationMs: Date.now() - new Date(startedAt).getTime(),
          output: teamResult.recommendedSystemPrompt,
          artifacts: [],
          tokensConsumed: { prompt: 0, completion: 0, total: 0 },
          cacheHit: false,
          retryCount: 0,
          // v2.1.3 新增字段：skipped 状态下未触发续写
          continueCount: 0,
          isPartial: false,
          error: "API Key 不可用，跳过 LLM 调用",
        };
        onProgress?.("skipped", "API Key 不可用，跳过 LLM 调用");
        return skipResult;
      }
      clientHandle = {
        client: created.client,
        model: created.model,
        baseURL: created.baseURL,
        temperature: created.temperature,
        thinkingEnabled: created.thinkingEnabled,
        // v1.6 P1-1：传递 reasoningEffort，让 buildThinkingRequestOptions 在 thinkingEnabled=true 时
        // 能正确构造 extra_body.reasoning_effort 参数（与 session.ts 主对话流程对齐）
        reasoningEffort: created.reasoningEffort,
      };
    }

    // ========================================================================
    // 阶段 3：调用 LLM（v2.1.3 重构：提取 callLlmOnce + 续写循环）
    // ========================================================================
    // v2.1.3 修复（架构评审 P1-1）：在闭包外做非空断言并赋值给 const 变量
    // 这样 TypeScript 能正确推断后续引用（包括 callLlmOnce 闭包）中 clientHandle 非空
    if (clientHandle === null) {
      // 理论上不会到达此分支（前面已检查），但为类型安全和防御性编程保留
      throw new Error("clientHandle 不可为 null（已达阶段 3）");
    }
    const handle: OpenAIClientHandle = clientHandle;

    onProgress?.("running", `调用 LLM: ${handle.model}...`);

    // 构造 messages：system prompt + user prompt
    const systemPrompt = teamResult.recommendedSystemPrompt;
    const userPrompt = buildUserPromptFromTask(task);

    // thinking 参数（v1.6 P1-1：与 session.ts 主对话流程保持一致）
    // v2.1.3：thinkingOptions 在 callLlmOnce 中复用，保持首次调用和续写调用的 thinking 模式一致
    // v1.1 修改：传入 handle.model 参数，支持 Qwen3 的 chat_template_kwargs.enable_thinking 格式
    const thinkingOptions = buildThinkingRequestOptions(
      handle.thinkingEnabled,
      handle.baseURL,
      handle.reasoningEffort ?? "high",
      handle.model
    );

    // 真实调用 OpenAI SDK
    // client 类型是 unknown，需要类型断言为 OpenAI SDK 客户端
    // 使用 ChatCompletion 类型避免 any（对齐 ESLint no-explicit-any 规则）
    // v1.6 P1-1 扩展：message 中增加 reasoning_content 字段（thinking 模式产出）
    // 部分 moka-ai / DeepSeek / Qwen3 模型在 thinkingEnabled=true 时，
    // 思考过程放在 reasoning_content 字段，最终答案放在 content 字段；
    // 但个别模型在 thinking 模式下可能将最终答案也放入 reasoning_content（content 为空）。
    // 因此响应解析需要支持 reasoning_content 作为 fallback，与 session.ts:3527-3528 保持一致。
    //
    // v2.1.3 扩展：新增 finish_reason 字段解析
    // OpenAI Chat Completions API 响应中，finish_reason="length" 表示输出被 maxTokens 截断。
    // 检测到此值时触发自动续写机制，让 LLM 从中断处继续输出。
    // 取值：stop（正常结束）/ length（截断）/ tool_calls（工具调用）/ content_filter（内容过滤）
    //
    // v2.1.3 修复（架构评审 P1-1）：openaiClient 从 handle.client 提取（handle 已断言非空）
    const openaiClient = handle.client as {
      chat: {
        completions: {
          create: (
            body: unknown,
            options?: { signal?: AbortSignal }
          ) => Promise<{
            choices: Array<{
              message?: {
                content?: string | null;
                reasoning_content?: string | null;
              };
              /** v2.1.3 新增：结束原因（stop/length/tool_calls/content_filter） */
              finish_reason?: string | null;
            }>;
            usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
          }>;
        };
      };
    };

    // ========================================================================
    // 阶段 3+4：调用 LLM + 解析响应 + 自动续写（v2.1.3 重构）
    // ========================================================================
    //
    // v2.1.3 改造说明：
    // - 提取 callLlmOnce 内部函数，封装单次 LLM 调用 + 响应解析 + 超时控制
    // - 新增续写循环：检测 finish_reason="length" 时自动续写，最多 maxContinueCount 次
    // - 续写消息：[system, user, assistant(已有部分), user(续写指令)]
    // - 续写时保持 thinking 参数和 reasoning_content fallback 逻辑（架构评审 P0-2/P0-3）

    /**
     * 单次 LLM 调用 + 响应解析（v2.1.3 新增）
     *
     * 封装 executeDispatch 中阶段 3（LLM 调用）+ 阶段 4（响应解析）的重复逻辑，
     * 供首次调用和续写循环复用。
     *
     * v2.1.3 修复（架构评审 P1-1）：clientHandle 作为参数显式传入，
     * 避免 TypeScript 在闭包中无法推断外部空值检查的 "possibly null" 错误。
     *
     * @param handle 非空的 OpenAIClientHandle（调用方负责 null 检查）
     * @param messages 消息数组（system + user + 可选 assistant + 可选续写 user）
     * @param timeoutMs 超时毫秒数（undefined 表示不超时）
     * @returns 解析后的响应：content（content || reasoning_content fallback）+ finishReason + usage
     */
    async function callLlmOnce(
      handle: OpenAIClientHandle,
      messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
      timeoutMs?: number
    ): Promise<{
      content: string;
      finishReason: string | null;
      usage: { promptTokens: number; completionTokens: number; totalTokens: number };
    }> {
      // 构建请求体（v2.1.3：复用外部 thinkingOptions，保持 thinking 模式一致）
      const requestBody: {
        model: string;
        messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
        temperature?: number;
        thinking?: { type: "enabled" | "disabled" };
        extra_body?: { reasoning_effort?: ReasoningEffort };
      } = {
        model: handle.model,
        messages,
        ...thinkingOptions,
      };
      if (handle.temperature !== undefined) {
        requestBody.temperature = handle.temperature;
      }

      // 请求选项（signal 放到这里，而非请求体）
      const requestOptions: { signal?: AbortSignal } = {};

      // 超时控制（v2.1.3：每次调用独立超时，避免单次续写卡死）
      let abortController: AbortController | null = null;
      let timeoutHandle: NodeJS.Timeout | null = null;
      if (timeoutMs !== undefined) {
        abortController = new AbortController();
        requestOptions.signal = abortController.signal;
        timeoutHandle = setTimeout(() => {
          abortController?.abort();
        }, timeoutMs);
      }

      try {
        const response = await openaiClient.chat.completions.create(requestBody, requestOptions);

        // 解析响应（v1.6 P1-1：content → reasoning_content fallback）
        const messageObj = response?.choices?.[0]?.message;
        const rawContent: string = messageObj?.content ?? "";
        const rawReasoning: string = messageObj?.reasoning_content ?? "";
        const content: string = rawContent || rawReasoning;

        // v2.1.3 新增：解析 finish_reason
        const finishReason: string | null = response?.choices?.[0]?.finish_reason ?? null;

        const usage = {
          promptTokens: response?.usage?.prompt_tokens ?? 0,
          completionTokens: response?.usage?.completion_tokens ?? 0,
          totalTokens: response?.usage?.total_tokens ?? 0,
        };

        return { content, finishReason, usage };
      } finally {
        // 清理超时定时器
        if (timeoutHandle !== null) {
          clearTimeout(timeoutHandle);
        }
      }
    }

    // --- 首次调用 LLM ---
    onProgress?.("running", `调用 LLM: ${handle.model}...`);
    const firstResult = await callLlmOnce(
      handle,
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      opts.timeoutMs
    );

    // 空内容 → failed
    if (!firstResult.content) {
      const failResult: DispatchResult = {
        taskId: task.taskId,
        dispatchId,
        matchedRole,
        status: "failed",
        startedAt,
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - new Date(startedAt).getTime(),
        output: "",
        artifacts: [],
        tokensConsumed: {
          prompt: firstResult.usage.promptTokens,
          completion: firstResult.usage.completionTokens,
          total: firstResult.usage.totalTokens,
        },
        cacheHit: false,
        retryCount: 0,
        continueCount: 0,
        isPartial: false,
        error: "LLM 返回空内容",
      };
      onProgress?.("failed", "LLM 返回空内容");
      return failResult;
    }

    // --- v2.1.3 新增：自动续写循环 ---
    // 当 finish_reason="length"（输出被 maxTokens 截断）时，自动发送续写请求
    // 续写消息：[system, user, assistant(已有部分), user(续写指令)]
    // 续写时保持 thinking 参数和 reasoning_content fallback（架构评审 P0-2/P0-3）

    /** 续写指令：让 LLM 从中断处继续输出，不重复已输出内容 */
    const CONTINUE_PROMPT = "请从中断处继续输出，不要重复已输出的内容。直接从中断的代码块内部继续，不要添加额外说明。";

    /** 最大续写次数（默认 3，可通过 DispatchOptions.maxContinueCount 配置） */
    const maxContinueCount = opts.maxContinueCount ?? 3;

    /** 累计的完整输出内容（首次内容 + 续写内容拼接） */
    let fullContent = firstResult.content;

    /**
     * 最近一次 LLM 响应的内容块（多角色审查 ARCH-08 修复）
     *
     * 续写意图检测只针对最近一次响应的内容块，而非拼接后的累计内容——
     * 若检测 fullContent，短续写块（<200 字符）会让前一块末尾的继续关键字
     * "滞留"在检测窗口内，shouldContinue 误判为 true，导致：
     * 多余续写调用 + 相同收尾内容被重复拼接 + isPartial 被误标记。
     * 初始值为首次响应内容；每次续写成功（内容非空）后更新为本次续写块。
     */
    let lastChunk = firstResult.content;

    /** 累计的 token 用量（首次 + 所有续写） */
    const totalUsage = {
      prompt: firstResult.usage.promptTokens,
      completion: firstResult.usage.completionTokens,
      total: firstResult.usage.totalTokens,
    };

    /** 续写次数 */
    let continueCount = 0;

    /** 是否为部分输出（截断后续写未完成） */
    let isPartial = false;

    /** 部分输出时的警告信息 */
    let partialError: string | undefined;

    /** 当前 finish_reason（用于续写循环条件判断） */
    let currentFinishReason = firstResult.finishReason;

    // 续写循环：shouldContinue 返回 true 且未达到最大续写次数时继续
    // v2.1.3 修正：continueCount 在 try 块开头自增，反映"尝试的续写次数"（无论成功失败）
    // 这样 TC-CONT-04（续写失败）和 TC-CONT-05（续写返回空）都能正确记录 continueCount=1
    //
    // v1.1 扩展：续写触发条件从单一的 finish_reason="length" 扩展为 shouldContinue()：
    // 1. finish_reason="length"（maxTokens 截断）
    // 2. finish_reason="stop" && detectContinueIntention(content)（LLM 主动停止但表示要继续）
    //
    // ARCH-08 修正：意图检测针对 lastChunk（最近一次响应块）而非 fullContent（累计内容）
    while (shouldContinue(currentFinishReason, lastChunk) && continueCount < maxContinueCount) {
      // 先自增 continueCount，表示"开始尝试第 N 次续写"
      continueCount++;
      onProgress?.("running", `LLM 输出被截断，正在续写 ${continueCount}/${maxContinueCount}...`);

      try {
        // 构建续写消息：system + user(原始) + assistant(已有部分) + user(续写指令)
        const continueResult = await callLlmOnce(
          handle,
          [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
            { role: "assistant", content: fullContent },
            { role: "user", content: CONTINUE_PROMPT },
          ],
          opts.timeoutMs
        );

        // 先累加 token 用量（多角色审查 TEST-02 修复）：
        // 无论续写内容是否为空，本次 API 调用已实际消耗 token，必须计入账单/配额统计
        totalUsage.prompt += continueResult.usage.promptTokens;
        totalUsage.completion += continueResult.usage.completionTokens;
        totalUsage.total += continueResult.usage.totalTokens;

        // 续写返回空内容：停止续写
        if (!continueResult.content) {
          partialError = `续写 ${continueCount} 返回空内容，已停止续写`;
          // 多角色审查 ARCH-01 修复：空内容的 isPartial 语义按续写触发原因区分——
          // 1. 若本次续写由确定截断（finish_reason="length"）触发：输出确定不完整，
          //    必须标记 isPartial=true（与 types.ts 契约"截断且续写未完成"一致）；
          // 2. 若由 stop+继续关键字触发：可能是 LLM 主动停止（输出未必截断），
          //    维持仅警告不标记 isPartial。
          // 注意：此处 currentFinishReason 仍是触发本次续写的原因（尚未被本次结果覆盖）
          if (currentFinishReason === "length") {
            isPartial = true;
          }
          break;
        }

        // 拼接续写内容（直接拼接，不添加分隔符）
        fullContent += continueResult.content;

        // ARCH-08：更新最近响应块——后续意图检测针对该块，
        // 避免前序块末尾的继续关键字在短块场景下"滞留"检测窗口导致误判
        lastChunk = continueResult.content;

        currentFinishReason = continueResult.finishReason;

        // 续写完成（不需要继续续写）
        if (!shouldContinue(currentFinishReason, lastChunk)) {
          break;
        }
      } catch (continueErr) {
        // 续写 API 错误：停止续写，标记为 partial
        const continueErrMsg = continueErr instanceof Error ? continueErr.message : String(continueErr);
        partialError = `续写 ${continueCount} 失败: ${continueErrMsg}`;
        isPartial = true;
        break;
      }
    }

    // 达到最大续写次数仍需续写：标记为 partial
    // 多角色审查 ARCH-09 修复：!partialError 前置——
    // 若循环因空内容/API 错误经 break 退出（partialError 已设置精确语义），
    // 不覆盖为通用文案（如空续写恰好发生在最后一次尝试时，
    // 保留"返回空内容"警告及 ARCH-01 的 isPartial 区分语义，
    // 且续写失败的具体错误原因不被替换、诊断信息不丢失）；
    // 仅在循环因次数耗尽自然退出（partialError 未设置）时才标记 partial。
    if (!partialError && shouldContinue(currentFinishReason, lastChunk) && continueCount === maxContinueCount) {
      isPartial = true;
      partialError = `输出可能不完整（达到最大续写次数 ${maxContinueCount}）`;
    }

    // --- 构造最终 DispatchResult ---
    const successMsg = isPartial
      ? `LLM 调用完成（续写 ${continueCount} 次，输出可能不完整），消耗 ${totalUsage.total} tokens`
      : `LLM 调用完成（续写 ${continueCount} 次），消耗 ${totalUsage.total} tokens`;
    onProgress?.("succeeded", successMsg);

    return {
      taskId: task.taskId,
      dispatchId,
      matchedRole,
      status: "succeeded",
      startedAt,
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - new Date(startedAt).getTime(),
      output: fullContent,
      artifacts: [],
      tokensConsumed: totalUsage,
      cacheHit: false,
      retryCount: 0,
      continueCount,
      isPartial,
      error: partialError,
    };
  } catch (err) {
    // 错误处理：errMsg 而非 errorMsg
    // v1.6 P0-2 修正（LL-003 / LL-007 / LL-008）：error 消息前缀改为 "LLM 调用失败"
    // 原因：测试期望 error 含 "LLM 调用失败" 关键字（涵盖 AbortError / TypeError / 其他异常）
    const errMsg = err instanceof Error ? err.message : String(err);
    return {
      taskId: task.taskId,
      dispatchId,
      matchedRole: {
        roleId: "solo-coder",
        roleName: "独立开发者",
        confidence: 0,
        matchedCapabilities: [],
        matchedSkills: [],
        missingCapabilities: [],
        reasons: [errMsg],
        scoreBreakdown: { capability: 0, skill: 0, keyword: 0, priority: 0 },
        strategy: "keyword",
      },
      status: "failed",
      startedAt,
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - new Date(startedAt).getTime(),
      error: `LLM 调用失败: ${errMsg}`,
      artifacts: [],
      tokensConsumed: { prompt: 0, completion: 0, total: 0 },
      cacheHit: false,
      retryCount: 0,
      // v2.1.3 新增字段：异常路径下未触发续写
      continueCount: 0,
      isPartial: false,
    };
  }
}

// ============================================================================
// 第六部分：辅助函数
// ============================================================================

/**
 * 列出所有角色（CLI 显示用）
 */
export function listAllRoles(): ReadonlyArray<RoleDefinition> {
  return ROLE_REGISTRY;
}

/**
 * 根据 roleId 获取角色定义（CLI 子命令用）
 */
export function getRoleById(roleId: string): RoleDefinition | null {
  return ROLE_MAP.get(roleId as RoleId) ?? null;
}

/**
 * 格式化角色信息为可读文本（CLI 显示）
 */
export function formatRoleInfo(role: RoleDefinition): string {
  const lines: string[] = [];
  lines.push(`# ${role.name} (${role.nameEn})`);
  lines.push("");
  lines.push(role.description);
  lines.push("");
  lines.push(`**优先级**: ${role.priority}/10`);
  lines.push(`**能力** (${role.capabilities.length}): ${role.capabilities.join(", ")}`);
  lines.push(`**技能** (${role.skills.length}): ${role.skills.join(", ")}`);
  lines.push(`**关键词** (${role.keywords.length}): ${role.keywords.join(", ")}`);
  return lines.join("\n");
}
