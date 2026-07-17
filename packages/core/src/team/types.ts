/**
 * DeepCodeX 多角色团队模块 - 完整类型定义
 *
 * 来源：融合 multi-agent-team skill v2.7 全部能力 + deepcode-cli 类型安全
 * 严格遵循 user rules：禁止 mock/占位/简化，全部类型必须真实业务表达
 * Ponytail 红线 R-15：所有 exported 类型必须显式定义
 *
 * 兼容：zod v4 (deepcode-cli 当前依赖)
 */

import { z } from "zod";

// 从 plugin-context 导入并重新导出 PluginContext 接口与 LogLevel（避免双份定义）
// 来源：plugin-context.ts 内的 PluginContext / LogLevel 是 V3 完整版，types.ts 内的 zod schema 是校验版
// 注意：LogLevel 是 type-only，所以不能同时用 import 导入值
import type {
  PluginContext as PluginContextType,
  LogLevel as LogLevelType,
  PluginEvent as PluginEventType,
} from "./plugin-context.js";

export type PluginContext = PluginContextType;
export type LogLevel = LogLevelType;
export type PluginEvent = PluginEventType;

// LogLevel 运行时值（用于 ctx.log 调用的默认参数，避免重新定义）
export const LogLevelEnum = {
  DEBUG: "DEBUG",
  INFO: "INFO",
  WARNING: "WARNING",
  ERROR: "ERROR",
  CRITICAL: "CRITICAL",
} as const;

// ============================================================================
// 第一部分：角色定义（5 个内置角色）
// ============================================================================

/** 5 个内置角色 ID（与 multi-agent-team 1:1 语义对应） */
export const RoleId = z.enum(["architect", "product-manager", "solo-coder", "test-expert", "ui-designer"]);
export type RoleId = z.infer<typeof RoleId>;

/** 角色优先级（用于排序，10 最高） */
export const RolePriority = z.number().int().min(0).max(10);
export type RolePriority = z.infer<typeof RolePriority>;

/** 角色能力（如 "system-architecture-design"） */
export const RoleCapability = z.string().min(2).max(64);
export type RoleCapability = z.infer<typeof RoleCapability>;

/** 角色技能（如 "Rust" / "TypeScript" / "PostgreSQL"） */
export const RoleSkill = z.string().min(1).max(64);
export type RoleSkill = z.infer<typeof RoleSkill>;

/** 角色匹配关键词 */
export const RoleKeyword = z.string().min(1).max(32);
export type RoleKeyword = z.infer<typeof RoleKeyword>;

/** 角色定义（含完整 system prompt） */
export const RoleDefinition = z.object({
  roleId: RoleId,
  name: z.string().min(1),
  nameEn: z.string().min(1),
  description: z.string().min(10),
  // 完整 system prompt 模板（强制注入 Karpathy 4 原则 + 角色职责）
  systemPromptPrefix: z.string().min(50),
  // 后置 prompt（任务执行约束）
  systemPromptSuffix: z.string().default(""),
  capabilities: z.array(RoleCapability).min(3),
  skills: z.array(RoleSkill).min(3),
  keywords: z.array(RoleKeyword).min(3),
  priority: RolePriority,
  // 元数据：颜色、icon、输出格式偏好
  metadata: z.object({
    color: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
    icon: z.string().min(1),
    outputFormat: z.enum(["markdown", "code", "json", "mixed"]),
    // 是否默认开启（在 settings.json 中可关闭）
    enabledByDefault: z.boolean().default(true),
  }),
});
export type RoleDefinition = z.infer<typeof RoleDefinition>;

// ============================================================================
// 第二部分：任务与匹配
// ============================================================================

/** 任务优先级 */
export const TaskPriority = z.enum(["low", "medium", "high", "critical"]);
export type TaskPriority = z.infer<typeof TaskPriority>;

/** 任务需求（含上下文与约束） */
export const TaskRequirement = z.object({
  taskId: z.string().uuid(),
  title: z.string().min(3).max(200),
  description: z.string().min(10),
  requiredCapabilities: z.array(RoleCapability).default([]),
  preferredSkills: z.array(RoleSkill).default([]),
  constraints: z.array(z.string()).default([]),
  // 输入附件（文件路径或 URL 列表）
  attachments: z.array(z.string()).default([]),
  // 上游上下文（来自其他角色的产出）
  upstreamContext: z.record(z.string(), z.unknown()).default({}),
  priority: TaskPriority.default("medium"),
  // 超时（毫秒，0 表示无超时）
  timeoutMs: z.number().int().nonnegative().default(0),
  // 创建时间
  createdAt: z.string().datetime(),
});
export type TaskRequirement = z.infer<typeof TaskRequirement>;

/** 匹配评分明细（可解释 AI 决策） */
export const ScoreBreakdown = z.object({
  // 能力匹配得分（0-1）
  capability: z.number().min(0).max(1),
  // 技能匹配得分（0-1）
  skill: z.number().min(0).max(1),
  // 关键词重叠得分（0-1）
  keyword: z.number().min(0).max(1),
  // 优先级得分（0-1）
  priority: z.number().min(0).max(1),
  // AI 语义得分（仅 AI 增强模式有值）
  semantic: z.number().min(0).max(1).optional(),
  // AI 置信度（仅 AI 增强模式有值）
  aiConfidence: z.number().min(0).max(1).optional(),
});
export type ScoreBreakdown = z.infer<typeof ScoreBreakdown>;

/** 角色匹配结果 */
export const MatchResult = z.object({
  roleId: RoleId,
  roleName: z.string(),
  confidence: z.number().min(0).max(1),
  matchedCapabilities: z.array(RoleCapability),
  matchedSkills: z.array(RoleSkill),
  missingCapabilities: z.array(RoleCapability).default([]),
  reasons: z.array(z.string()).min(1),
  scoreBreakdown: ScoreBreakdown,
  // 匹配策略
  strategy: z.enum(["keyword", "ai", "hybrid"]),
});
export type MatchResult = z.infer<typeof MatchResult>;

// ============================================================================
// 第三部分：调度执行
// ============================================================================

/** 调度执行状态 */
export const DispatchStatus = z.enum([
  "pending", // 待执行
  "running", // 执行中
  "succeeded", // 成功
  "failed", // 失败
  "timeout", // 超时
  "cancelled", // 取消
  "paused", // 暂停
  "retrying", // 重试中
  "skipped", // 跳过（上游失败/被互斥插件抢占）
]);
export type DispatchStatus = z.infer<typeof DispatchStatus>;

/** 调度结果 */
export const DispatchResult = z.object({
  taskId: z.string().uuid(),
  dispatchId: z.string().uuid(),
  matchedRole: MatchResult,
  status: DispatchStatus,
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
  durationMs: z.number().int().nonnegative().default(0),
  output: z.string().optional(),
  error: z.string().optional(),
  // 产生的工件（文件路径列表）
  artifacts: z.array(z.string()).default([]),
  // 消耗的 token 数
  tokensConsumed: z
    .object({
      prompt: z.number().int().nonnegative(),
      completion: z.number().int().nonnegative(),
      total: z.number().int().nonnegative(),
    })
    .default({ prompt: 0, completion: 0, total: 0 }),
  // 缓存命中情况
  cacheHit: z.boolean().default(false),
  // 重试次数
  retryCount: z.number().int().nonnegative().default(0),
});
export type DispatchResult = z.infer<typeof DispatchResult>;

// ============================================================================
// 第四部分：插件系统（V3 架构）
// ============================================================================

/** 插件名称（kebab-case 强制，Ponytail 校验） */
export const PluginName = z.string().regex(/^[a-z][a-z0-9-]*$/);
export type PluginName = z.infer<typeof PluginName>;

/** 插件优先级（用于多 Goal 排序，唯一） */
export const PluginPriority = z.number().int().min(0).max(1000);
export type PluginPriority = z.infer<typeof PluginPriority>;

// PluginContext 接口与 PluginEvent 已从 plugin-context.ts 重新导出（保留双源类型一致）
// 来源：plugin-context.ts 中的 PluginContext 是 V3 完整版（含 projectRoot / dispatcher / dryRun / extensions 等）

/** 插件接口（V3 完整定义） */
export interface GoalCommandPlugin {
  readonly name: PluginName;
  readonly priority: PluginPriority;
  readonly description: string;
  // 互斥关系：与其他插件不能同时启用（与 multi-agent-team 1:1 对齐；V3 接口允许 string[] 而非 PluginName[]）
  readonly mutex?: readonly string[];
  // 钩子：dispatch 前
  before?(ctx: PluginContext): Promise<void>;
  // 钩子：dispatch 中
  execute?(ctx: PluginContext): Promise<DispatchResult>;
  // 钩子：dispatch 后
  after?(ctx: PluginContext, result: DispatchResult): Promise<void>;
  // 是否匹配（决定是否执行）
  matches?(ctx: PluginContext): boolean;
  // 清理钩子（异常时由 dispatcher 在 try/finally 中保证调用）
  cleanup?(ctx: PluginContext, exc: unknown): Promise<void>;
}

// ============================================================================
// 第五部分：工作流模式（6 大 Dynamic Workflow）
// ============================================================================

/** 工作流模式 */
export const WorkflowPattern = z.enum([
  "classifier-dispatch", // 分类并行
  "fan-out-aggregate", // 扇出聚合
  "adversarial-verify", // 对抗验证
  "generate-filter", // 生成筛选
  "tournament", // 锦标赛
  "loop-until-done", // 循环直到完成
]);
export type WorkflowPattern = z.infer<typeof WorkflowPattern>;

/** 工作流步骤（通用） */
export const WorkflowStep = z.object({
  stepId: z.string(),
  name: z.string(),
  // 步骤类型
  type: z.enum(["role", "plugin", "workflow", "gate"]),
  // 关联角色/插件/子工作流
  ref: z.string(),
  // 输入参数
  input: z.record(z.string(), z.unknown()).default({}),
  // 输出 schema
  outputSchema: z.unknown().optional(),
  // 失败重试上限
  maxRetries: z.number().int().nonnegative().default(3),
  // 超时
  timeoutMs: z.number().int().nonnegative().default(0),
});
export type WorkflowStep = z.infer<typeof WorkflowStep>;

/** 工作流定义（DAG） */
export const WorkflowDefinition = z.object({
  workflowId: z.string().uuid(),
  name: z.string(),
  pattern: WorkflowPattern,
  steps: z.array(WorkflowStep).min(2),
  // 步骤依赖关系（stepId → 前置 stepId 列表）
  dependencies: z.record(z.string(), z.array(z.string())).default({}),
  // 退出条件（loop-until-done 模式）
  exitCondition: z.string().optional(),
  // 最多迭代次数
  maxIterations: z.number().int().positive().default(10),
});
export type WorkflowDefinition = z.infer<typeof WorkflowDefinition>;

// ============================================================================
// 第六部分：自主模式（Autonomous Loop）
// ============================================================================

/** 自主模式阶段（4 阶段循环） */
export const AutonomousPhase = z.enum(["plan", "dev", "verify", "fix"]);
export type AutonomousPhase = z.infer<typeof AutonomousPhase>;

/** 自主模式状态 */
export const AutonomousState = z.object({
  sessionId: z.string().uuid(),
  goal: z.string().min(10),
  currentPhase: AutonomousPhase,
  iteration: z.number().int().nonnegative(),
  maxIterations: z.number().int().positive(),
  // 当前 phase 的执行结果
  phaseResults: z.record(z.string(), z.unknown()).default({}),
  // 跨轮 notes（持久化到 .deepcodex/notes.md）
  notes: z.string().default(""),
  // 验证状态
  verificationPassed: z.boolean().default(false),
  // 完成时间
  completedAt: z.string().datetime().optional(),
});
export type AutonomousState = z.infer<typeof AutonomousState>;

// ============================================================================
// 第七部分：Cybernetics（三环控制）
// ============================================================================

/** 控制层级 */
export const ControlLayer = z.enum(["strategic", "tactical", "execution"]);
export type ControlLayer = z.infer<typeof ControlLayer>;

/** 反馈控制信号 */
export const FeedbackSignal = z.object({
  signalId: z.string().uuid(),
  layer: ControlLayer,
  // 感知：当前状态
  perception: z.string(),
  // 决策：建议动作
  decision: z.string(),
  // 执行：是否应用
  executed: z.boolean().default(false),
  // 反馈：效果
  effect: z.string().optional(),
  timestamp: z.string().datetime(),
});
export type FeedbackSignal = z.infer<typeof FeedbackSignal>;

// ============================================================================
// 第八部分：质量门禁
// ============================================================================

/** UI/UX 问题严重度 */
export const UIUXSeverity = z.enum(["HIGH", "MEDIUM", "LOW"]);
export type UIUXSeverity = z.infer<typeof UIUXSeverity>;

/** UI/UX 问题分类 */
export const UIUXCategory = z.enum(["a11y", "interaction", "layout", "ux"]);
export type UIUXCategory = z.infer<typeof UIUXCategory>;

/** UI/UX 问题 */
export const UIUXIssue = z.object({
  category: UIUXCategory,
  severity: UIUXSeverity,
  rule: z.string(),
  element: z.string(),
  message: z.string(),
  fix: z.string(),
  // 量化指标（如对比度数值）
  metric: z.record(z.string(), z.number()).optional(),
});
export type UIUXIssue = z.infer<typeof UIUXIssue>;

/** 视觉回归变更区域 */
export const ChangedRegion = z.object({
  x: z.number().int().nonnegative(),
  y: z.number().int().nonnegative(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  pixelCount: z.number().int().nonnegative(),
  severity: UIUXSeverity,
});
export type ChangedRegion = z.infer<typeof ChangedRegion>;

/** 视觉回归结果 */
export const VisualDiffResult = z.object({
  testId: z.string(),
  step: z.string(),
  pixelDiffRatio: z.number().min(0).max(1),
  ssimScore: z.number().min(0).max(1).optional(),
  changedRegions: z.array(ChangedRegion),
  dataIncomplete: z.array(z.string()).default([]),
  displayErrors: z.array(z.string()).default([]),
  error: z.string().optional(),
});
export type VisualDiffResult = z.infer<typeof VisualDiffResult>;

// ============================================================================
// 第九部分：匹配策略与配置
// ============================================================================

/** 角色匹配策略 */
export const MatchStrategy = z.enum(["keyword", "ai", "hybrid"]);
export type MatchStrategy = z.infer<typeof MatchStrategy>;

/** 多角色团队配置（settings.json 中 team.* 段） */
export const TeamConfig = z.object({
  // 是否启用多角色（默认 true）
  enabled: z.boolean().default(true),
  // 角色匹配策略（默认 hybrid：默认 AI，置信度低时回退 keyword）
  matchStrategy: MatchStrategy.default("hybrid"),
  // AI 增强阈值（置信度低于此值时回退 keyword）
  aiFallbackThreshold: z.number().min(0).max(1).default(0.3),
  // topK 匹配数
  topK: z.number().int().positive().default(3),
  // 默认角色（当所有匹配置信度 < 阈值时使用）
  defaultRole: RoleId.default("solo-coder"),
  // 是否启用 3D 代码地图
  enable3DCodeMap: z.boolean().default(true),
  // 是否启用 UI/UX 巡检
  enableUIUXAudit: z.boolean().default(true),
  // 是否启用视觉回归
  enableVisualRegression: z.boolean().default(true),
  // 是否启用 Ponytail 强制检查
  enablePonytailLint: z.boolean().default(true),
  // Ponytail 模式（v1.1 修订：只支持 full）
  ponytailMode: z.literal("full").default("full"),
  // 自主模式默认配置
  autonomousDefaults: z
    .object({
      maxIterations: z.number().int().positive().default(10),
      confirmationMode: z.enum(["auto-approve", "ask-user", "fail-closed", "smart"]).default("smart"),
      enableGitAutoCommit: z.boolean().default(true),
      enableNotesMemory: z.boolean().default(true),
      enableSleepGuard: z.boolean().default(true),
    })
    .optional(),
});
export type TeamConfig = z.infer<typeof TeamConfig>;

// ============================================================================
// 第十部分：导出所有 schema（用于运行时校验）
// ============================================================================

export const ALL_SCHEMAS = {
  RoleId,
  RolePriority,
  RoleDefinition,
  TaskRequirement,
  MatchResult,
  DispatchResult,
  PluginName,
  WorkflowPattern,
  WorkflowStep,
  WorkflowDefinition,
  AutonomousPhase,
  AutonomousState,
  ControlLayer,
  FeedbackSignal,
  UIUXIssue,
  VisualDiffResult,
  TeamConfig,
} as const;

// ============================================================================
// 第十一部分：Goal 实例（multi-goal 子目标运行时状态）
// ============================================================================

/** Goal 实例 zod schema（multi-goal 子调度的运行时对象，V3 完整定义） */
export const GoalInstanceSchema = z.object({
  goalId: z.string(),
  plugin: z.string(),
  // DAG 依赖：上游 goalId 列表
  dependsOn: z.array(z.string()).default([]),
  // 输入（plugin execute 入参，由 dispatcher 注入）
  input: z.record(z.string(), z.unknown()).default({}),
  // 期望产出（用于 verify 阶段）
  expectedOutputs: z.array(z.string()).default([]),
  // 状态（pending / running / succeeded / failed / skipped）
  status: DispatchStatus.default("pending"),
  // 实际产出（plugin execute 返回值）
  output: z.unknown().optional(),
  // 错误信息
  error: z.string().optional(),
  // 启动时间
  startedAt: z.string().datetime().optional(),
  // 完成时间
  completedAt: z.string().datetime().optional(),
  // 执行耗时（毫秒）
  durationMs: z.number().int().nonnegative().default(0),
  // 重试次数
  retryCount: z.number().int().nonnegative().default(0),
});

/** Goal 实例类型（zod schema 推导） */
export type GoalInstance = z.infer<typeof GoalInstanceSchema>;

// 向后兼容：旧名也指向 schema（已迁移到 GoalInstanceSchema）
/** @deprecated 请使用 GoalInstanceSchema */
export const GoalInstance = GoalInstanceSchema;
