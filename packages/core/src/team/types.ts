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
  /**
   * v1.1 新增：任务业务标签（用于 DomainExpertMatcher 匹配）
   * - 默认空数组，向后兼容（既有 TaskRequirement 实例不受影响）
   * - 由调用方显式填充，如 ["金融", "风控", "合规"]
   * - DomainExpertMatcher.computeDomainTagMatch 使用 Jaccard 相似度匹配
   */
  domainTags: z.array(z.string().min(1)).default([]),
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
  /**
   * v1.1 新增：业务领域标签匹配得分（0-1）
   * - DomainExpertMatcher 使用时为必填（权重 40%）
   * - RoleMatcher 不使用此字段（保持 undefined，向后兼容）
   * - Jaccard 相似度算法：|任务标签 ∩ 专家标签| / |任务标签 ∪ 专家标签|
   */
  domainTag: z.number().min(0).max(1).optional(),
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

// ============================================================================
// 第 9.5 部分：领域专家（Domain Expert，v1.1 新增）
//
// 设计依据：DOMAIN_EXPERT_INTEGRATION_DESIGN.md v1.1.1
// 与 RoleDefinition 平行，不修改 RoleDefinition，向后兼容
// 专家来源：woagent builtin-agent-templates.yml（78 角色，14 部门，纳入 30 个）
// ============================================================================

/**
 * 领域专家类别（按业务领域分类，与 woagent 14 个部门中的 8 个纳入部门对齐）
 *
 * v1.1 P0-2：与 DomainCategory 对齐 woagent 实际部门结构
 */
export const DomainCategory = z.enum([
  "product", // 业务需求类（对应 woagent product 部门，4 个角色）
  "project-management", // 业务流程类（对应 woagent project_management 部门，3 个角色）
  "strategy", // 业务战略类（对应 woagent strategy 部门，4 个角色）
  "support", // 业务支持类（对应 woagent support 部门，4 个角色）
  "specialized", // 专业领域类（对应 woagent specialized 部门，5 个角色）
  "academic", // 学术领域类（对应 woagent academic 部门，4 个角色）
  "marketing", // 营销业务类（对应 woagent marketing 部门，选择性纳入 5 个）
  "sales", // 销售业务类（对应 woagent sales 部门，选择性纳入 1 个）
]);
export type DomainCategory = z.infer<typeof DomainCategory>;

/**
 * 领域专家 ID（v1.1 P1-1：强制 domain- 前缀）
 *
 * 设计依据：
 *   1. RoleId enum 为 ["architect", "product-manager", "solo-coder", "test-expert", "ui-designer"]
 *   2. woagent 中也有 product-manager / cloud-architect / data-scientist 等同名角色
 *   3. 通过 regex 强制前缀，类型层面确保 DomainExpert 与 RoleDefinition 命名空间隔离
 *   4. runtime 由 DomainExpertRegistry.register 再做一道校验（P1-7 三道命名冲突检测）
 */
export const DomainExpertId = z
  .string()
  .regex(/^domain-[a-z][a-z0-9-]*$/, "expertId 必须以 'domain-' 开头，后接 kebab-case 字符串");
export type DomainExpertId = z.infer<typeof DomainExpertId>;

/**
 * 领域专家定义（业务需求/review 阶段的领域专家）
 *
 * v1.1 P0-2 字段对齐 RoleDefinition：
 *   - systemPromptSuffix：与 RoleDefinition.systemPromptSuffix 对齐，支持后置约束
 *   - priority：与 RoleDefinition.priority 对齐，用于匹配排序兜底
 *   - mutex：互斥专家 ID 列表（如 legal-compliance 与 finance-tracker 不可同时调用）
 *   - dependsOn：依赖专家 ID 列表（如 blockchain-security-auditor 依赖 cloud-architect）
 *   - sourceRef：woagent 源文件角色名或 commit hash，便于追溯
 *   - version：专家定义版本号，semver 格式
 */
export const DomainExpert = z.object({
  /** 专家 ID（强制 domain- 前缀，详见 P1-1） */
  expertId: DomainExpertId,
  /** 中文名 */
  name: z.string().min(1),
  /** 英文名 */
  nameEn: z.string().min(1),
  /** 业务类别 */
  category: DomainCategory,
  /** 专长（如"价值投资"、"医疗合规"） */
  specialty: z.string().min(1),
  /** 描述（≥10 字符） */
  description: z.string().min(10),
  /**
   * 完整 system prompt 前缀（强制注入 Karpathy 4 原则 + Ponytail 16 红线，≥50 字符）
   * 迁移自 woagent 角色 prompt，但必须注入 KARPATHY_PREAMBLE（与 RoleDefinition 一致）
   */
  systemPromptPrefix: z.string().min(50),
  /** 后置 prompt（任务执行约束，与 RoleDefinition.systemPromptSuffix 对齐） */
  systemPromptSuffix: z.string().default(""),
  /** 能力列表（≥3 个） */
  capabilities: z.array(RoleCapability).min(3),
  /** 技能列表（≥3 个） */
  skills: z.array(RoleSkill).min(3),
  /** 匹配关键词（≥3 个） */
  keywords: z.array(RoleKeyword).min(3),
  /**
   * 业务领域标签（用于动态匹配，如 ["金融", "医疗", "零售"]，≥1 个）
   * DomainExpertMatcher.computeDomainTagMatch 使用 Jaccard 相似度匹配
   */
  domainTags: z.array(z.string().min(1)).min(1),
  /** 优先级（0-10，用于匹配排序兜底，与 RoleDefinition.priority 对齐） */
  priority: RolePriority.default(5),
  /** 互斥专家 ID 列表（同一任务不可同时调用，默认空） */
  mutex: z.array(DomainExpertId).default([]),
  /** 依赖专家 ID 列表（调用本专家前必须先调用的专家，默认空） */
  dependsOn: z.array(DomainExpertId).default([]),
  /** 元数据 */
  metadata: z.object({
    /** 颜色（hex 格式） */
    color: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
    /** 图标（emoji 或 icon 名称） */
    icon: z.string().min(1),
    /** 输出格式偏好 */
    outputFormat: z.enum(["markdown", "code", "json", "mixed"]),
    /** 是否默认开启（在 settings.json 中可关闭） */
    enabledByDefault: z.boolean().default(true),
    /** 来源标记（woagent 迁移 / custom 自定义） */
    source: z.enum(["woagent", "custom"]),
    /** 源引用（woagent 角色名或 commit hash，便于追溯，v1.1 P0-2 新增） */
    sourceRef: z.string().optional(),
    /** 专家定义版本号（semver，v1.1 P0-2 新增） */
    version: z
      .string()
      .regex(/^\d+\.\d+\.\d+$/)
      .default("1.0.0"),
  }),
});
export type DomainExpert = z.infer<typeof DomainExpert>;

/**
 * 领域专家匹配结果
 *
 * 与 MatchResult 平行，但字段指向 DomainExpert 而非 RoleDefinition
 * v1.1 P1-NEW-4：DomainExpertReviewPlugin.execute 使用此类型构建返回值
 */
export const DomainExpertMatchResult = z.object({
  /** 匹配的专家定义 */
  expert: DomainExpert,
  /** 综合置信度（0-1，加权求和） */
  confidence: z.number().min(0).max(1),
  /** 评分明细（含 domainTag 字段） */
  scoreBreakdown: ScoreBreakdown,
  /** 匹配策略（与 MatchStrategy 对齐） */
  strategy: MatchStrategy,
  /** 匹配原因（中文，可解释 AI 决策） */
  reasons: z.array(z.string()).min(1),
  /** 命中的能力列表 */
  matchedCapabilities: z.array(RoleCapability).default([]),
  /** 命中的技能列表 */
  matchedSkills: z.array(RoleSkill).default([]),
  /** 命中的业务标签列表 */
  matchedDomainTags: z.array(z.string()).default([]),
});
export type DomainExpertMatchResult = z.infer<typeof DomainExpertMatchResult>;

/**
 * 领域专家匹配选项（与 MatchOptions 对齐，但默认值不同）
 */
export const DomainMatchOptions = z.object({
  /** 匹配策略（默认 hybrid：先 keyword 取 topK*2，再用 AI 重排序） */
  strategy: MatchStrategy.default("hybrid"),
  /** topK 匹配数（默认 3） */
  topK: z.number().int().positive().default(3),
  /** AI 增强阈值（置信度低于此值时回退 keyword，默认 0.3） */
  aiFallbackThreshold: z.number().min(0).max(1).default(0.3),
  /** 项目根目录（用于读取 .env 中的 OpenAI API Key） */
  projectRoot: z.string().default(process.cwd()),
  /** 注入的 OpenAI 客户端（用于单元测试，禁止 mock） */
  injectedClient: z.unknown().optional(),
  /** 单次 LLM 调用超时（毫秒，默认 30000） */
  timeoutMs: z.number().int().positive().default(30000),
});
export type DomainMatchOptions = z.infer<typeof DomainMatchOptions>;

/**
 * 领域专家 Matcher 构造选项
 */
export const DomainMatcherOptions = z.object({
  /** 启用的业务类别（与 TeamConfig.enabledCategories 对齐，默认空） */
  enabledCategories: z.array(DomainCategory).default([]),
  /** 默认匹配选项（未显式指定时使用） */
  defaultMatchOptions: DomainMatchOptions.optional(),
});
export type DomainMatcherOptions = z.infer<typeof DomainMatcherOptions>;

/**
 * 专家意见（DomainExpertReviewPlugin 调用 LLM 后的产出）
 *
 * v1.1 P1-NEW-4：用于 DomainExpertReviewPlugin.execute 构建 DomainExpertDispatchResult
 */
export const ExpertOpinion = z.object({
  /** 专家 ID */
  expertId: DomainExpertId,
  /** 专家中文名 */
  expertName: z.string().min(1),
  /** review 意见（markdown 格式，含关键观点、风险、建议） */
  opinion: z.string().min(1),
  /** 置信度（0-1，专家对自身意见的置信度） */
  confidence: z.number().min(0).max(1),
  /** 关键观点（结构化摘要，便于汇总） */
  keyPoints: z.array(z.string()).default([]),
  /** 风险提示（专家识别的业务风险） */
  risks: z.array(z.string()).default([]),
  /** 建议措施（专家给出的具体建议） */
  recommendations: z.array(z.string()).default([]),
});
export type ExpertOpinion = z.infer<typeof ExpertOpinion>;

/**
 * 领域专家调度结果（v1.1 P1-NEW-4：扩展 DispatchResult 支持 DomainExpert）
 *
 * 设计依据：DispatchResult.matchedRole 类型为 MatchResult（含 roleId: RoleId），
 * 与 DomainExpertMatchResult.expert 类型 DomainExpert（含 expertId: DomainExpertId）不兼容。
 * 因此新增 DomainExpertDispatchResult 类型，平行于 DispatchResult。
 */
export const DomainExpertDispatchResult = z.object({
  /** 任务 ID（与 DispatchResult.taskId 对齐） */
  taskId: z.string().uuid(),
  /** 调度 ID（与 DispatchResult.dispatchId 对齐） */
  dispatchId: z.string().uuid(),
  /** 匹配的专家列表（topK，与 DispatchResult.matchedRole 区别：支持多个专家） */
  matchedExperts: z.array(DomainExpertMatchResult),
  /** 调度状态（与 DispatchStatus 对齐） */
  status: DispatchStatus,
  /** 启动时间 */
  startedAt: z.string().datetime(),
  /** 完成时间 */
  completedAt: z.string().datetime().optional(),
  /** 执行耗时（毫秒） */
  durationMs: z.number().int().nonnegative().default(0),
  /** 专家意见汇总（markdown 格式，由 summarizeOpinions 生成） */
  output: z.string().optional(),
  /** 错误信息（单个专家失败不影响其他专家，汇总错误信息） */
  error: z.string().optional(),
  /** 产生的工件（文件路径列表） */
  artifacts: z.array(z.string()).default([]),
  /** 消耗的 token 数（所有专家累计） */
  tokensConsumed: z
    .object({
      prompt: z.number().int().nonnegative(),
      completion: z.number().int().nonnegative(),
      total: z.number().int().nonnegative(),
    })
    .default({ prompt: 0, completion: 0, total: 0 }),
  /** 缓存命中情况 */
  cacheHit: z.boolean().default(false),
  /** 重试次数 */
  retryCount: z.number().int().nonnegative().default(0),
});
export type DomainExpertDispatchResult = z.infer<typeof DomainExpertDispatchResult>;

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
  /**
   * v1.1 新增：是否启用领域专家（默认 false，用户显式开启）
   * 设计依据：用户原话"动态根据业务调用，非全部静态注册"
   */
  enableDomainExperts: z.boolean().default(false),
  /** v1.1 新增：领域专家匹配 topK（默认 3） */
  domainExpertTopK: z.number().int().positive().default(3),
  /** v1.1 新增：领域专家置信度阈值（默认 0.3） */
  domainExpertThreshold: z.number().min(0).max(1).default(0.3),
  /**
   * v1.1 P1-6 新增：启用的业务类别（默认空数组，由用户显式启用）
   * 设计依据：用户原话"动态根据业务调用，非全部静态注册"
   * 若 enabledCategories 为空且 enableDomainExperts=true，则提示用户配置
   */
  enabledCategories: z.array(DomainCategory).default([]),
  /** v1.1 新增：领域专家匹配策略（与 matchStrategy 对齐，默认 hybrid） */
  domainExpertMatchStrategy: MatchStrategy.default("hybrid"),
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
  // v1.1 新增：领域专家相关 schema（DOMAIN_EXPERT_INTEGRATION_DESIGN.md §3.1）
  DomainCategory,
  DomainExpertId,
  DomainExpert,
  DomainExpertMatchResult,
  DomainMatchOptions,
  DomainMatcherOptions,
  ExpertOpinion,
  DomainExpertDispatchResult,
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
