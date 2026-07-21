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
      };
    }

    // ========================================================================
    // 阶段 3：调用 LLM（两参数 SDK 调用：body + options）
    // ========================================================================
    onProgress?.("running", `调用 LLM: ${clientHandle.model}...`);

    // 构造 messages：system prompt + user prompt
    const systemPrompt = teamResult.recommendedSystemPrompt;
    const userPrompt = buildUserPromptFromTask(task);

    // 请求体（不包含 signal，signal 放到第二参数 options 中）
    const llmRequestBody: {
      model: string;
      messages: Array<{ role: "system" | "user"; content: string }>;
      temperature?: number;
    } = {
      model: clientHandle.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    };
    if (clientHandle.temperature !== undefined) {
      llmRequestBody.temperature = clientHandle.temperature;
    }

    // 请求选项（signal 放到这里，而非请求体）
    // OpenAI SDK 两参数签名：chat.completions.create(body, options?)
    // signal 在 options 中（非 body）
    const llmRequestOptions: { signal?: AbortSignal } = {};

    // 超时控制：通过 AbortController 实现
    let abortController: AbortController | null = null;
    let timeoutHandle: NodeJS.Timeout | null = null;
    if (opts.timeoutMs !== undefined) {
      abortController = new AbortController();
      llmRequestOptions.signal = abortController.signal;
      timeoutHandle = setTimeout(() => {
        abortController?.abort();
      }, opts.timeoutMs);
    }

    // 真实调用 OpenAI SDK
    // client 类型是 unknown，需要类型断言为 OpenAI SDK 客户端
    // 使用 ChatCompletion 类型避免 any（对齐 ESLint no-explicit-any 规则）
    const openaiClient = clientHandle.client as {
      chat: {
        completions: {
          create: (
            body: unknown,
            options?: { signal?: AbortSignal }
          ) => Promise<{
            choices: Array<{ message?: { content?: string | null } }>;
            usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
          }>;
        };
      };
    };
    let response: {
      choices: Array<{ message?: { content?: string | null } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    try {
      response = await openaiClient.chat.completions.create(llmRequestBody, llmRequestOptions);
    } finally {
      // 清理超时定时器
      if (timeoutHandle !== null) {
        clearTimeout(timeoutHandle);
      }
    }

    // ========================================================================
    // 阶段 4：解析 LLM 响应
    // ========================================================================
    const outputContent: string = response?.choices?.[0]?.message?.content ?? "";
    if (!outputContent) {
      // 空内容 → failed
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
          prompt: response?.usage?.prompt_tokens ?? 0,
          completion: response?.usage?.completion_tokens ?? 0,
          total: response?.usage?.total_tokens ?? 0,
        },
        cacheHit: false,
        retryCount: 0,
        error: "LLM 返回空内容",
      };
      onProgress?.("failed", "LLM 返回空内容");
      return failResult;
    }

    // 成功：构造完整 DispatchResult
    const tokensConsumed = {
      prompt: response?.usage?.prompt_tokens ?? 0,
      completion: response?.usage?.completion_tokens ?? 0,
      total: response?.usage?.total_tokens ?? 0,
    };

    onProgress?.("succeeded", `LLM 调用完成，消耗 ${tokensConsumed.total} tokens`);

    return {
      taskId: task.taskId,
      dispatchId,
      matchedRole,
      status: "succeeded",
      startedAt,
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - new Date(startedAt).getTime(),
      output: outputContent,
      artifacts: [],
      tokensConsumed,
      cacheHit: false,
      retryCount: 0,
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
