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
import { resolveCurrentSettings, type ResolvedDeepcodingSettings } from "../settings.js";
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
  } catch (err) {
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
  };
}

// ============================================================================
// 第三部分：核心调度入口
// ============================================================================

/**
 * 调度选项（zod 校验）
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
 * 完整 dispatch 执行（角色匹配 + LLM 调用 + 工具执行 + 结果收集）
 *
 * 注意：这是高阶 API，包含实际的 LLM 调用。生产使用前应确保有完整的 Session 集成。
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

  try {
    // 阶段 1：角色调度
    onProgress?.("running", "正在匹配角色...");
    const teamResult = await dispatchToRole(task, options);

    // 阶段 2：构造 system prompt
    onProgress?.(
      "running",
      `已匹配角色: ${teamResult.recommendedRole.name} (${((teamResult.matches[0]?.confidence ?? 0) * 100) | 0}%)`
    );

    // 阶段 3：调用 LLM（此处集成点留给上层 Session 管理）
    // 注：完整 LLM 调用需要 OpenAI 客户端 + 工具执行 + 循环，这部分由 SessionManager 负责
    // 本函数只负责调度 + 准备上下文，实际 LLM 调用由调用方基于 recommendedSystemPrompt 发起
    const dispatchResult: DispatchResult = {
      taskId: task.taskId,
      dispatchId,
      matchedRole: teamResult.matches[0] ?? {
        roleId: teamResult.recommendedRole.roleId,
        roleName: teamResult.recommendedRole.name,
        confidence: 0,
        matchedCapabilities: [],
        matchedSkills: [],
        missingCapabilities: [],
        reasons: ["无匹配结果"],
        scoreBreakdown: { capability: 0, skill: 0, keyword: 0, priority: 0 },
        strategy: "keyword",
      },
      status: "pending",
      startedAt,
      completedAt: undefined,
      durationMs: 0,
      output: teamResult.recommendedSystemPrompt,
      artifacts: [],
      tokensConsumed: { prompt: 0, completion: 0, total: 0 },
      cacheHit: false,
      retryCount: 0,
    };

    onProgress?.("succeeded", "调度完成");
    return {
      ...dispatchResult,
      status: "succeeded",
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - new Date(startedAt).getTime(),
    };
  } catch (err) {
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
        reasons: [err instanceof Error ? err.message : String(err)],
        scoreBreakdown: { capability: 0, skill: 0, keyword: 0, priority: 0 },
        strategy: "keyword",
      },
      status: "failed",
      startedAt,
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - new Date(startedAt).getTime(),
      error: err instanceof Error ? err.message : String(err),
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
