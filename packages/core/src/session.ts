import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import matter from "gray-matter";
import ejs from "ejs";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { launchNotifyScript } from "./common/notify";
import { buildThinkingRequestOptions } from "./common/openai-thinking";
import { DEEPSEEK_V4_MODELS } from "./common/model-capabilities";
import { readTextFileWithMetadata } from "./common/file-utils";
import {
  buildSkillDocumentsPrompt,
  getCompactPrompt,
  getDefaultSkillPrompt,
  getExtensionRoot,
  getPlanModePrompt,
  getRuntimeContext,
  getSystemPrompt,
  getTools,
  type ToolDefinition,
} from "./prompt";
import {
  ToolExecutor,
  type CreateOpenAIClient,
  type CreateLLMClient,
  type ProcessTimeoutControl,
  type ProcessTimeoutInfo,
  type ToolCallExecution,
  type ToolExecutionHooks,
} from "./tools/executor";
import { McpManager } from "./mcp/mcp-manager";
import type { McpServerConfig, PermissionScope, PermissionSettings } from "./settings";
import { resolveCurrentSettings } from "./settings";
import { ProviderFactory } from "./providers/provider-factory";
import type { LLMClient, LLMResponse, LLMToolDefinition, LLMUsage } from "./providers/llm-provider";
import { logApiError } from "./common/error-logger";
import { logOpenAIChatCompletionDebug, normalizeDebugError } from "./common/debug-logger";
import { killProcessTree } from "./common/process-tree";
import { GitFileHistory, type FileHistoryCheckpointResult } from "./common/file-history";
import { clearSessionState, getSnippet, rebuildSessionStateFromHistory } from "./common/state";
import {
  appendProjectPermissionAllows,
  buildPermissionToolExecution,
  computeToolCallPermissions,
  hasUserPermissionReplies,
  normalizeAskPermissions,
  parseToolCallForPermissions,
  type AskPermissionRequest,
  type MessageToolPermission,
  type PermissionToolCall,
  type UserToolPermission,
} from "./common/permissions";
import { clearSessionWorkingDir } from "./tools/bash-handler";
import { reportNewPrompt } from "./common/telemetry";
import { OpenAIMessageConverter } from "./common/openai-message-converter";
// EAG-P0 新增导入：LoopGuard 共享上限保护 + IndependentEvaluator 评估器外挂（§5.4 / §5.2.1）
// 注：仅导入类型和类，不触发 EAG 模块初始化（外挂式，未注入时零开销）
import type { LoopGuard } from "./common/loop-guard";
import type {
  IndependentEvaluator,
  RedlineDefinition,
  EvaluationContext,
  EvaluationReport,
  EvaluationVerdict,
} from "./eag/evaluator/types";
// EAG-P2 批次 9 S5 新增导入：CODING Loop 编排器外挂（§4.7 / §4.9）
// 注：仅导入类型与类，未注入 codingOrchestrator 时零开销（向后兼容，§4.9.4）
import type { CodingOrchestrator } from "./eag/coding";
import type { CodingLoopRequest, CodingLoopResult, PkcAccessor } from "./eag/coding/types";
// EAG-P3 批次 10 新增导入：TESTING Loop + 长程自动化 + DESIGN Loop 命令 Hook + RLIS 规则学习器
// 注：仅导入类型与类，未注入对应 orchestrator 时零开销（向后兼容，§4.18.5）
// 设计依据：EAG-P3 批次 10 设计文档 §4.9.3 / §4.18.3 / §4.18.4
// - TestingOrchestrator：/eag-test 命令编排器（外挂注入，未注入时命令不可用）
// - DesignLoopOrchestrator：/eag-design 命令编排器（外挂注入，未注入时命令不可用）
// - RunStateStore：/eag-run /eag-resume /eag-status 共享依赖（外挂注入，未注入时三命令不可用）
// - RuleLearner：候选规则检测 Hook 依赖（外挂注入，未注入时 Hook 跳过）
// - EagRunHandler/EagResumeHandler/EagStatusHandler：长程自动化命令处理器
//   注：在 handle 方法内部按需构造（依赖 MultiLoopPlanner/MilestoneTagger/BlockageAnalyzer）
import type { TestingOrchestrator } from "./eag/testing";
import type { TestingLoopRequest, TestingLoopResult } from "./eag/testing/types";
import type { DesignLoopOrchestrator } from "./eag/design/design-orchestrator";
import type { DesignLoopInput, DesignLoopResult } from "./eag/design/design-models";
import type { RunStateStore } from "./eag/long-horizon/run-state-store";
import type { RuleLearner } from "./eag/rlis/rule-learner";
import type { RuleCandidate } from "./eag/rlis/types";
import {
  EagRunHandler,
  EagResumeHandler,
  EagStatusHandler,
  MultiLoopPlanner,
  MilestoneTagger,
  BlockageAnalyzer,
} from "./eag/long-horizon";
import type {
  EagRunRequest,
  EagRunResult,
  EagResumeRequest,
  EagStatusRequest,
  EagStatusResult,
} from "./eag/long-horizon";
// EAG-P3 批次 11 S3 新增导入：CLI 命令解析器（§5 S3 改进方案 D-S3-1 / D-S3-4）
// 注：EagCommandParser 是无状态纯函数式解析器，构造零成本，默认注入保证向后兼容
// - 负责判定 /eag-build /eag-design /eag-test /eag-run /eag-resume /eag-status /eag-deploy 7 个命令
// - 从 userPrompt.messageParams 提取预装配的请求对象
// - 通过 SessionManagerOptions.eagCommandParser 可选注入（默认 new EagCommandParser()）
import { EagCommandParser } from "./eag/cli";
// EAG-P4 批次 13 新增导入：DevOps 第 6 角色编排器 + DEPLOY Loop 上下文与结果类型（§3.4 / §5.2）
// 注：仅导入类型与类，未注入 devopsOrchestrator 时 /eag-deploy 命令不可用（向后兼容，零开销）
// - DevOpsOrchestrator：/eag-deploy 命令编排器（外挂注入，构造期装配 IaC 生成器 / G-8 门禁 /
//   部署策略 / DeployStage / 事件发射器等全部依赖）
// - DevOpsContext / DevOpsResult：DevOpsOrchestrator.run() 的入参与产出类型
// - DeployRequest：/eag-deploy 命令请求对象（由 EagCommandParser.parse() 从 messageParams 提取）
// 设计决策（与设计文档 §5.2 N-M-1 修复对齐）：
// - 调用方在 SessionManagerOptions.devopsOrchestrator 中注入完整装配的 DevOpsOrchestrator 实例
// - session.ts 仅负责校验注入 + 装配 DevOpsContext + 调用 run() + 渲染 DevOpsResult
// - 不在 handleEagDeployCommand 内部 new DevOpsOrchestrator（避免每次命令重复构造，且与
//   codingOrchestrator / testingOrchestrator / designOrchestrator 同构）
import type { DevOpsOrchestrator } from "./eag/devops/devops-orchestrator";
import type { DevOpsContext, DevOpsResult } from "./eag/devops/types";
import type { DeployRequest } from "./eag/cli/eag-command-parser";
// EAG-P5 Phase 5.4 TASK-P5-5.4-002 新增导入：EAG-P5 无人值守编排器 + /eag-autonomous 命令处理器
// 注：仅导入类型与类，未注入 autonomousOrchestrator 时 /eag-autonomous 命令不可用（向后兼容，零开销）
// - AutonomousOrchestrator：/eag-autonomous 命令编排器（外挂注入，构造期装配 LoopExecutor /
//   RunStateStore / NotesMemory / GuardChain / SmartConfirmation 全部依赖）
// - EagAutonomousCommandHandler：命令处理器类，负责装配 AutonomousRunRequest + 调用 run() + 渲染结果
// - extractEagAutonomousRequestFromPrompt：独立函数，从命令字符串解析参数（用于错误回显）
// - EagAutonomousRequest：/eag-autonomous 命令请求对象类型
// 设计决策（对齐 EAG-P4 批次 13 §5.2 N-M-1 修复 + Karpathy Simplicity First）：
// - 调用方在 SessionManagerOptions.autonomousOrchestrator 中注入完整装配的 AutonomousOrchestrator 实例
// - session.ts 仅负责校验注入 + 装配请求 + 调用 handler.execute() + 渲染结果
// - 不在 handleEagAutonomousCommand 内部 new AutonomousOrchestrator（避免每次命令重复构造）
import type { AutonomousOrchestrator } from "./eag/p5/autonomous-orchestrator";
import { EagAutonomousCommandHandler, extractEagAutonomousRequestFromPrompt } from "./eag/cli";
import type { EagAutonomousRequest, EagAutonomousCommandResult } from "./eag/cli";

export type { PermissionScope } from "./settings";
export type {
  AskPermissionRequest,
  AskPermissionScope,
  BashPermissionScope,
  MessageToolPermission,
  PermissionDecision,
  UserToolPermission,
} from "./common/permissions";

const MAX_SESSION_ENTRIES = 50;
const MAX_PROJECT_CODE_LENGTH = 64;
const PROJECT_CODE_HASH_LENGTH = 16;
const BACKGROUND_FAILURE_LOG_TAIL_CHARS = 4000;
const DEFAULT_COMPACT_PROMPT_TOKEN_THRESHOLD = 128 * 1024;
const DEEPSEEK_V4_COMPACT_PROMPT_TOKEN_THRESHOLD = 512 * 1024;
const PLAN_MODE_ON_STATUS_MESSAGE = "  └ Set Plan Mode on. Awaiting <proposed_plan>.";
const PLAN_MODE_OFF_STATUS_MESSAGE = "  └ Set Plan Mode off.";
const PLAN_MODE_FORCE_ASK_SCOPES = [
  "write-in-cwd",
  "write-out-cwd",
  "delete-in-cwd",
  "delete-out-cwd",
  "mutate-git-log",
] as const satisfies readonly PermissionScope[];

type ChatCompletionDebugOptions = {
  enabled?: boolean;
  location: string;
  baseURL?: string;
  params?: Record<string, unknown>;
};

export function getCompactPromptTokenThreshold(model: string): number {
  return DEEPSEEK_V4_MODELS.has(model)
    ? DEEPSEEK_V4_COMPACT_PROMPT_TOKEN_THRESHOLD
    : DEFAULT_COMPACT_PROMPT_TOKEN_THRESHOLD;
}

// Keep project storage paths short enough for Git's internal files on Windows.
export function getProjectCode(projectRoot: string): string {
  const legacyCode = getLegacyProjectCode(projectRoot);
  if (legacyCode.length <= MAX_PROJECT_CODE_LENGTH) {
    return legacyCode;
  }

  const normalizedRoot = path.resolve(projectRoot);
  const hashInput = process.platform === "win32" ? normalizedRoot.toLowerCase() : normalizedRoot;
  const hash = crypto.createHash("sha256").update(hashInput).digest("hex").slice(0, PROJECT_CODE_HASH_LENGTH);
  const prefixLimit = MAX_PROJECT_CODE_LENGTH - PROJECT_CODE_HASH_LENGTH - 1;
  const basename = path.basename(normalizedRoot);
  const prefix =
    sanitizeProjectCodePart(basename)
      .slice(0, prefixLimit)
      .replace(/[-.]+$/g, "") || "project";
  return `${prefix}-${hash}`;
}

function getLegacyProjectCode(projectRoot: string): string {
  return projectRoot.replace(/[\\/]/g, "-").replace(/:/g, "");
}

function sanitizeProjectCodePart(value: string): string {
  return value
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
}

function isUsageRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function summarizeCompletionOptions(options?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!options) {
    return undefined;
  }
  return {
    ...options,
    signal: options.signal instanceof AbortSignal ? { aborted: options.signal.aborted } : options.signal,
  };
}

function addUsageValue(current: unknown, next: unknown): unknown {
  if (typeof next === "number") {
    return (typeof current === "number" ? current : 0) + next;
  }

  if (isUsageRecord(next)) {
    const currentRecord = isUsageRecord(current) ? current : {};
    const result: Record<string, unknown> = { ...currentRecord };
    for (const [key, value] of Object.entries(next)) {
      result[key] = addUsageValue(currentRecord[key], value);
    }
    return result;
  }

  return next;
}

function accumulateUsage(current: ModelUsage | null, next: unknown | null | undefined): ModelUsage | null {
  if (next == null) {
    return current ?? null;
  }
  return addUsageValue(current, next) as ModelUsage;
}

function usageWithRequestCount(usage: ModelUsage): ModelUsage {
  const totalReqs = typeof usage.total_reqs === "number" ? usage.total_reqs + 1 : 1;
  return {
    ...usage,
    total_reqs: totalReqs,
  };
}

function accumulateUsagePerModel(
  current: Record<string, ModelUsage> | null | undefined,
  model: string,
  next: ModelUsage | null | undefined
): Record<string, ModelUsage> | null {
  if (next == null) {
    return current ?? null;
  }

  const usagePerModel = { ...(current ?? {}) };
  const modelName = model.trim() || "unknown";
  usagePerModel[modelName] = accumulateUsage(usagePerModel[modelName] ?? null, usageWithRequestCount(next))!;
  return usagePerModel;
}

function getTotalTokens(usage: ModelUsage | null | undefined): number {
  if (!isUsageRecord(usage)) {
    return 0;
  }
  const totalTokens = usage.total_tokens;
  return typeof totalTokens === "number" ? totalTokens : 0;
}

/**
 * 统一 LLMUsage → 会话持久化 ModelUsage 转换
 * （B1：compactSession 接线 provider 层；2026-07-18 设计 §4.4 cache 语义修正）
 *
 * 字段映射（修正版，一处定义两通路共享）：
 * - prompt_tokens ← inputTokens + cacheCreation + cacheRead。
 *   语义事实：Anthropic 的 input_tokens 不含 cache_read/cache_creation（三者独立计量计费），
 *   而 DeepSeek 的 prompt_tokens 为输入总量（= prompt_cache_hit + prompt_cache_miss）。
 *   消费方约束：getTotalTokens 只读 total_tokens → activeTokens → 驱动 compact 阈值；
 *   若 prompt_tokens 不含 cache 命中部分，prompt caching 生效时 activeTokens 被严重低估
 *   （cache 命中可占上下文 90%+），compact 永不触发 → 上下文溢出。故必须含 cache 部分；
 * - completion_tokens ← outputTokens；total_tokens = prompt_tokens + completion_tokens；
 * - cacheReadInputTokens → prompt_cache_hit_tokens（命中计量，缺省不输出字段）；
 * - inputTokens + cacheCreationInputTokens → prompt_cache_miss_tokens
 *   （未命中计量 = 新输入 + 写缓存，缺省不输出字段）。
 * DeepSeek 自有 prompt_cache_hit/miss_tokens 不经此函数（主对话流式通路保持原样透传）。
 * OpenAI provider 的 LLMUsage 永无 cache 字段，映射结果与修正前逐值相等（OpenAI 通路零变化）。
 */
function toModelUsage(usage: LLMUsage | null): ModelUsage | null {
  if (!usage) {
    return null;
  }
  const cacheCreation = usage.cacheCreationInputTokens ?? 0;
  const cacheRead = usage.cacheReadInputTokens ?? 0;
  const promptTokens = usage.inputTokens + cacheCreation + cacheRead;
  return {
    prompt_tokens: promptTokens,
    completion_tokens: usage.outputTokens,
    total_tokens: promptTokens + usage.outputTokens,
    ...(usage.cacheReadInputTokens != null ? { prompt_cache_hit_tokens: usage.cacheReadInputTokens } : {}),
    ...(usage.cacheCreationInputTokens != null
      ? { prompt_cache_miss_tokens: usage.inputTokens + usage.cacheCreationInputTokens }
      : {}),
  };
}

export type SessionStatus =
  | "failed"
  | "pending"
  | "processing"
  | "waiting_for_user"
  | "completed"
  | "interrupted"
  | "ask_permission"
  | "permission_denied";

export type ModelUsage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  completion_tokens_details?: Record<string, unknown>;
  prompt_tokens_details?: Record<string, unknown>;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
  total_reqs?: number;
};

export type SessionProcessEntry = {
  startTime: string;
  command: string;
  timeoutMs?: number;
  deadlineAt?: string;
  timedOut?: boolean;
};

export type BashTimeoutAdjustment = {
  processId: string;
  timeoutMs: number;
  deadlineAt: string;
  timedOut: boolean;
};

export type SessionEntry = {
  id: string;
  summary: string | null;
  assistantReply: string | null;
  assistantThinking: string | null;
  assistantRefusal: string | null;
  toolCalls: unknown[] | null;
  status: SessionStatus;
  failReason: string | null;
  usage: ModelUsage | null;
  usagePerModel: Record<string, ModelUsage> | null;
  activeTokens: number;
  createTime: string;
  updateTime: string;
  processes: Map<string, SessionProcessEntry> | null; // {pid: process info}
  askPermissions?: AskPermissionRequest[];
  planMode?: boolean;
};

export type SessionsIndex = {
  version: 1;
  entries: SessionEntry[];
  originalPath: string;
};

export type SessionMessageRole = "system" | "user" | "assistant" | "tool";

export type MessageMeta = {
  function?: unknown;
  paramsMd?: string;
  resultMd?: string;
  asThinking?: boolean;
  isSummary?: boolean;
  isModelChange?: boolean;
  skill?: SkillInfo;
  permissions?: MessageToolPermission[];
  userPrompt?: UserPromptContent;
};

export type SessionMessage = {
  id: string;
  sessionId: string;
  role: SessionMessageRole;
  content: string | null;
  contentParams: unknown | null;
  messageParams: unknown | null;
  compacted: boolean;
  visible: boolean;
  createTime: string;
  updateTime: string;
  meta?: MessageMeta;
  html?: string;
  checkpointHash?: string;
};

export type UndoTarget = {
  message: SessionMessage;
  index: number;
  canRestoreCode: boolean;
};

export type UserPromptContent = {
  text?: string;
  imageUrls?: string[];
  skills?: SkillInfo[];
  permissions?: UserToolPermission[];
  alwaysAllows?: PermissionScope[];
  planMode?: boolean;
  /**
   * EAG-P2 批次 9 S5：自定义元数据（可选，§4.9.3）
   *
   * 用于在 `/eag-build` 命令中透传 CodingLoopRequest 等编排参数。
   * 调用方通过 `messageParams.codingLoopRequest` 传入预装配的请求。
   *
   * 注：此字段为通用元数据容器，不强制 schema 校验（由消费方自行校验字段）。
   * 既有命令路径（/continue、/plan 等）不读取此字段，向后兼容。
   */
  messageParams?: Record<string, unknown> | null;
};

export type SkillInfo = {
  name: string;
  path: string;
  description: string;
  isLoaded?: boolean;
  allowImplicitInvocation?: boolean;
};

type SessionManagerOptions = {
  projectRoot: string;
  createOpenAIClient: CreateOpenAIClient;
  /**
   * B1：统一 LLM 客户端工厂（可选注入，测试缝合点）。
   *
   * 未注入时走默认实现：resolveCurrentSettings(projectRoot) + ProviderFactory 路由；
   * 返回 null 表示无可用凭据，对应非流式场景的静默降级语义。
   */
  createLLMClient?: CreateLLMClient;
  getResolvedSettings: () => {
    model: string;
    webSearchTool?: string;
    mcpServers?: Record<string, McpServerConfig>;
    permissions?: Required<PermissionSettings>;
    enabledSkills?: Record<string, boolean>;
  };
  renderMarkdown: (text: string) => string;
  onAssistantMessage: (message: SessionMessage, shouldConnect: boolean) => void;
  onSessionEntryUpdated?: (entry: SessionEntry) => void;
  onLlmStreamProgress?: (progress: LlmStreamProgress) => void;
  onMcpStatusChanged?: () => void;
  onProcessStdout?: (pid: number, chunk: string) => void;
  /**
   * EAG-P0：独立评估器外挂（可选注入，§5.4 Goal Evaluator 接入主循环）
   *
   * 未注入时主循环行为完全不变（向后兼容，V2 526 测试零回归）。
   * 注入后，在主循环 !toolCalls 判定点（LLM 给出最终回复且无工具调用）外挂调用评估器，
   * 评估器按红线清单独立判定产出物，verdict 决定是否终止。
   *
   * EAG-P0 范围（最小必要集，评审 D-1 共识）：
   * - pass → 任务完成（主循环 return）
   * - fix/human_checkpoint/stop_failure → 通知用户评估结果（不做 FIX 回灌，留待 EAG-P2）
   * - 评估器调用失败 → 降级为无操作（不阻塞主循环 return）
   */
  evaluator?: IndependentEvaluator;
  /**
   * EAG-P0：循环上限保护器（可选注入，§5.2.1 共享上限保护）
   *
   * 未注入时使用内置 maxIterations=80000（向后兼容）。
   * 注入后，循环顶部调用 guard.check() 判定是否允许继续执行，
   * 触达上限（max_iterations/max_tokens/连续失败）时终止并通知用户。
   *
   * 配置 Object.freeze 冻结保证（§5.12.3 AU-5）：LLM 在循环内不可自改上限。
   *
   * 跨 session 共享语义（架构师审查 Minor-3 修复）：
   * - 推荐per-session 注入（每次 activateSession 构造新 LoopGuard），避免跨会话状态污染
   *   （consecutiveFailures/tokensConsumed 跨 session 累加可能导致下一次 session 一开始就超限）
   * - 跨 session 单例仅适用于 autonomous 长程任务场景（§5.12.3 AU-6 熔断回滚需跨迭代跟踪）
   */
  loopGuard?: LoopGuard;
  /**
   * EAG-P0：评估器红线清单（可选注入，§5.1.3 企业红线 + §5.5 RLIS 规则即红线）
   *
   * 未注入时评估器跳过判定（EAG-P0 降级语义）。
   * 注入后，作为 evaluator.evaluate() 的 redlines 参数传入。
   * 来源可以是：
   * - 企业红线 E1~E8/UI-01/02/DEP-01~07（EAG-P1 起由范式库提供）
   * - RLIS 三层规则转换的红线（ruleStore.formatForEvaluator()，EAG-P0 起）
   */
  evaluatorRedlines?: ReadonlyArray<RedlineDefinition>;
  /**
   * EAG-P2 批次 9 S5：CODING Loop 编排器（可选注入，§4.7 / §4.9.2）
   *
   * 未注入时 `/eag-build` 命令不可用，主对话循环行为完全不变（向后兼容，§4.9.4）。
   * 注入后，在主对话循环检测到 `/eag-build` 命令时外挂调用 handleEagBuildCommand，
   * 路由到 CodingOrchestrator.run() 执行 Phase A → B → STRICT → FIX 完整闭环。
   *
   * 配套依赖：pkcAccessor 必须同时注入（CodingOrchestrator 通过 ContextAssembler 访问 PKC）。
   *
   * 不可变优先（§5.12.4 G-A6d）：构造后字段不可变，循环内不可被 LLM 修改。
   */
  codingOrchestrator?: CodingOrchestrator;
  /**
   * EAG-P2 批次 9 S5：PKC 知识库访问器（可选注入，§4.9.3）
   *
   * 未注入时 CODING Loop 不可用（CodingOrchestrator 构造需 ContextAssembler，
   * ContextAssembler 需 PkcAccessor 注入）。
   * 注入后，作为 CodingLoopRequest.pkcAccessor 传入编排器。
   *
   * 与 codingOrchestrator 配套使用，单独注入无效。
   */
  pkcAccessor?: PkcAccessor;
  /**
   * EAG-P3 批次 10：TESTING Loop 编排器（可选注入，§4.18.3）
   *
   * 未注入时 `/eag-test` 命令不可用，主对话循环行为完全不变（向后兼容）。
   * 注入后，在主对话循环检测到 `/eag-test` 命令时外挂调用 handleEagTestCommand，
   * 路由到 TestingOrchestrator.run() 执行契约/E2E/覆盖率门禁完整闭环。
   *
   * 不可变优先（§5.12.4 G-A6d）：构造后字段不可变，循环内不可被 LLM 修改。
   */
  testingOrchestrator?: TestingOrchestrator;
  /**
   * EAG-P3 批次 10：DESIGN Loop 编排器（可选注入，§4.18.3）
   *
   * 未注入时 `/eag-design` 命令不可用，向后兼容。
   * 注入后，在主对话循环检测到 `/eag-design` 命令时外挂调用 handleEagDesignCommand，
   * 路由到 DesignLoopOrchestrator.run() 执行 PM→架构师→评估器完整闭环。
   */
  designOrchestrator?: DesignLoopOrchestrator;
  /**
   * EAG-P4 批次 13：DevOps 第 6 角色编排器（可选注入，§3.4 / §5.2）
   *
   * 未注入时 `/eag-deploy` 命令不可用，主对话循环行为完全不变（向后兼容）。
   * 注入后，在主对话循环检测到 `/eag-deploy` 命令时外挂调用 handleEagDeployCommand，
   * 路由到 DevOpsOrchestrator.run() 执行 5 步编排（IaC 生成 → 校验 → DeployStage 4 步阶段 → G-8 门禁）。
   *
   * 设计决策（与设计文档 §5.2 N-M-1 修复对齐）：
   * - 调用方负责在注入前完整装配 DevOpsOrchestratorOptions（iacGenerators / gateG8Checker /
   *   deployStrategy / deployStage / eventEmitter）
   * - session.ts 不负责构造 DeployStage 实例（避免每次命令重复构造，且与
   *   codingOrchestrator / testingOrchestrator / designOrchestrator 同构）
   *
   * 不可变优先（§5.12.4 G-A6d）：构造后字段不可变，循环内不可被 LLM 修改。
   */
  devopsOrchestrator?: DevOpsOrchestrator;
  /**
   * EAG-P5 Phase 5.4：无人值守编排器（可选注入，§4.1 / §5 CLI 命令规范）
   *
   * 未注入时 `/eag-autonomous` 命令不可用，主对话循环行为完全不变（向后兼容）。
   * 注入后，在主对话循环检测到 `/eag-autonomous` 命令时外挂调用 handleEagAutonomousCommand，
   * 路由到 AutonomousOrchestrator.run() 执行 4 阶段循环（plan → dev → verify → fix）。
   *
   * 设计决策（对齐 EAG-P4 批次 13 §5.2 N-M-1 修复 + Karpathy Simplicity First）：
   * - 调用方负责在注入前完整装配 AutonomousOrchestratorOptions（loopExecutor /
   *   runStateStore / notesMemory / guardChain / smartConfirmation 全部依赖）
   * - session.ts 不负责构造这些依赖（避免每次命令重复构造，且与
   *   codingOrchestrator / testingOrchestrator / designOrchestrator / devopsOrchestrator 同构）
   *
   * 不可变优先（§5.12.4 G-A6d）：构造后字段不可变，循环内不可被 LLM 修改。
   */
  autonomousOrchestrator?: AutonomousOrchestrator;
  /**
   * EAG-P3 批次 10：RunState 持久化存储（可选注入，§4.18.3）
   *
   * 未注入时 `/eag-run` `/eag-resume` `/eag-status` 三命令不可用，向后兼容。
   * 注入后，三个命令分别构造 EagRunHandler / EagResumeHandler / EagStatusHandler，
   * 并共享此 RunStateStore 实例（保证 run→resume→status 状态一致）。
   *
   * 配套依赖（在 handle 方法内部按需构造，无需调用方注入）：
   * - MultiLoopPlanner（无外部依赖，构造零成本）
   * - MilestoneTagger（依赖 runStateStore，本字段注入后即可构造）
   * - BlockageAnalyzer（依赖 runStateStore，本字段注入后即可构造）
   */
  runStateStore?: RunStateStore;
  /**
   * EAG-P3 批次 10：RLIS 规则学习器（可选注入，§4.18.3 / §4.18.4）
   *
   * 未注入时候选规则检测 Hook（detectRuleCandidateHook）跳过，向后兼容。
   * 注入后，主对话循环每次用户输入后调用 detectRuleCandidateHook：
   *   1. detectCorrection 检测纠正模式
   *   2. extractCandidate 提取规则候选
   *   3. accumulateCandidate 累积候选（同类纠正 occurrenceCount+1）
   *   4. shouldPushConfirmation 判定是否推送确认请求（≥2 次才推送，§5.5.4 防误学红线）
   *   5. 推送确认请求 → 用户回复 `/rule-confirm <id>` 后由调用方调用 confirmCandidate
   */
  ruleLearner?: RuleLearner;
  /**
   * EAG-P3 批次 11 S3：CLI 命令解析器（可选注入，§5 S3 改进方案 D-S3-4）
   *
   * 未注入时使用默认 `new EagCommandParser()`，主对话循环行为完全不变（向后兼容）。
   * 注入后，主对话循环通过 eagCommandParser.parse(userPrompt) 分发 6 个 EAG 命令：
   *   - /eag-build → handleEagBuildCommand（CODING Loop 编排）
   *   - /eag-design → handleEagDesignCommand（DESIGN Loop 编排）
   *   - /eag-test → handleEagTestCommand（TESTING Loop 编排）
   *   - /eag-run → handleEagRunCommand（长程自动化启动）
   *   - /eag-resume → handleEagResumeCommand（长程自动化恢复）
   *   - /eag-status → handleEagStatusCommand（长程进度查询）
   *
   * 测试缝合点：可通过注入自定义 EagCommandParser 实例替换默认解析器，
   * 用于单元测试中模拟命令解析行为（不使用 mock 框架，符合用户规则 P-5）。
   */
  eagCommandParser?: EagCommandParser;
};

export type LlmStreamProgress = {
  requestId: string;
  sessionId?: string;
  startedAt: string;
  estimatedTokens: number;
  formattedTokens: string;
  phase: "start" | "update" | "end";
};

export class SessionManager {
  private readonly projectRoot: string;
  private readonly createOpenAIClient: CreateOpenAIClient;
  private readonly createLLMClientOverride?: CreateLLMClient;
  private readonly getResolvedSettings: () => {
    model: string;
    webSearchTool?: string;
    mcpServers?: Record<string, McpServerConfig>;
    permissions?: Required<PermissionSettings>;
    enabledSkills?: Record<string, boolean>;
  };
  private readonly onAssistantMessage: (message: SessionMessage, shouldConnect: boolean) => void;
  private readonly onSessionEntryUpdated?: (entry: SessionEntry) => void;
  private readonly onLlmStreamProgress?: (progress: LlmStreamProgress) => void;
  private readonly onMcpStatusChanged?: () => void;
  private readonly onProcessStdout?: (pid: number, chunk: string) => void;
  private activeSessionId: string | null = null;
  private activePromptController: AbortController | null = null;
  private readonly sessionControllers = new Map<string, AbortController>();
  private readonly processTimeoutControls = new Map<string, ProcessTimeoutControl>();
  private readonly liveProcessKeys = new Set<string>();
  private readonly toolExecutor: ToolExecutor;
  private readonly mcpManager = new McpManager();
  private mcpToolDefinitions: ToolDefinition[] = [];
  private readonly messageConverter: OpenAIMessageConverter;
  // EAG-P0 外挂字段（可选注入，未注入时主循环行为不变，§5.4 / §5.2.1）
  private readonly evaluator?: IndependentEvaluator;
  private readonly loopGuard?: LoopGuard;
  private readonly evaluatorRedlines?: ReadonlyArray<RedlineDefinition>;
  // EAG-P2 批次 9 S5 外挂字段（可选注入，未注入时 /eag-build 命令不可用，§4.7 / §4.9）
  private readonly codingOrchestrator?: CodingOrchestrator;
  private readonly pkcAccessor?: PkcAccessor;
  // EAG-P3 批次 10 外挂字段（可选注入，未注入时对应命令不可用，§4.18.3）
  // - testingOrchestrator：未注入时 /eag-test 命令不可用
  // - designOrchestrator：未注入时 /eag-design 命令不可用
  // - runStateStore：未注入时 /eag-run /eag-resume /eag-status 三命令不可用
  // - ruleLearner：未注入时候选规则检测 Hook 跳过（不影响主对话循环）
  private readonly testingOrchestrator?: TestingOrchestrator;
  private readonly designOrchestrator?: DesignLoopOrchestrator;
  private readonly runStateStore?: RunStateStore;
  private readonly ruleLearner?: RuleLearner;
  // EAG-P4 批次 13 外挂字段（可选注入，未注入时 /eag-deploy 命令不可用，§3.4 / §5.2）
  // - devopsOrchestrator：未注入时 /eag-deploy 命令不可用
  //   调用方在 SessionManagerOptions.devopsOrchestrator 中注入完整装配的 DevOpsOrchestrator 实例
  //   （iacGenerators / gateG8Checker / deployStrategy / deployStage / eventEmitter 全部依赖）
  private readonly devopsOrchestrator?: DevOpsOrchestrator;
  // EAG-P5 Phase 5.4 外挂字段（可选注入，未注入时 /eag-autonomous 命令不可用，§4.1 / §5 CLI 命令规范）
  // - autonomousOrchestrator：未注入时 /eag-autonomous 命令不可用
  //   调用方在 SessionManagerOptions.autonomousOrchestrator 中注入完整装配的 AutonomousOrchestrator 实例
  //   （loopExecutor / runStateStore / notesMemory / guardChain / smartConfirmation 全部依赖）
  private readonly autonomousOrchestrator?: AutonomousOrchestrator;
  // EAG-P3 批次 11 S3：CLI 命令解析器（§5 S3 改进方案 D-S3-4）
  // - 默认 new EagCommandParser()，保证向后兼容（未注入时主循环行为不变）
  // - 负责判定 6 个 EAG 命令字符串并从 messageParams 提取预装配的请求对象
  // - 替代原 session.ts 中的 6 个 isEagXxxPrompt + 6 个 extractXxxRequest 私有方法
  private readonly eagCommandParser: EagCommandParser;

  constructor(options: SessionManagerOptions) {
    this.projectRoot = options.projectRoot;
    this.createOpenAIClient = options.createOpenAIClient;
    this.createLLMClientOverride = options.createLLMClient;
    this.getResolvedSettings = options.getResolvedSettings;
    this.onAssistantMessage = options.onAssistantMessage;
    this.onSessionEntryUpdated = options.onSessionEntryUpdated;
    this.onLlmStreamProgress = options.onLlmStreamProgress;
    this.onMcpStatusChanged = options.onMcpStatusChanged;
    this.onProcessStdout = options.onProcessStdout;
    this.toolExecutor = new ToolExecutor(this.projectRoot, this.createOpenAIClient, this.mcpManager, () =>
      this.createLLMClient()
    );
    this.mcpManager.prepare(this.getResolvedSettings().mcpServers);
    this.messageConverter = new OpenAIMessageConverter({
      renderInitPrompt: () => this.renderInitCommandPrompt(),
    });
    // EAG-P0 外挂字段赋值（可选注入，未注入时为 undefined，主循环行为不变）
    this.evaluator = options.evaluator;
    this.loopGuard = options.loopGuard;
    this.evaluatorRedlines = options.evaluatorRedlines;
    // EAG-P2 批次 9 S5 外挂字段赋值（可选注入，未注入时 /eag-build 命令不可用）
    this.codingOrchestrator = options.codingOrchestrator;
    this.pkcAccessor = options.pkcAccessor;
    // EAG-P3 批次 10 外挂字段赋值（可选注入，未注入时对应命令不可用）
    this.testingOrchestrator = options.testingOrchestrator;
    this.designOrchestrator = options.designOrchestrator;
    this.runStateStore = options.runStateStore;
    this.ruleLearner = options.ruleLearner;
    // EAG-P4 批次 13 外挂字段赋值（可选注入，未注入时 /eag-deploy 命令不可用）
    // 调用方负责在注入前完整装配 DevOpsOrchestratorOptions（iacGenerators / gateG8Checker /
    // deployStrategy / deployStage / eventEmitter），session.ts 不负责构造依赖
    this.devopsOrchestrator = options.devopsOrchestrator;
    // EAG-P5 Phase 5.4 外挂字段赋值（可选注入，未注入时 /eag-autonomous 命令不可用）
    // 调用方负责在注入前完整装配 AutonomousOrchestratorOptions（loopExecutor / runStateStore /
    // notesMemory / guardChain / smartConfirmation），session.ts 不负责构造依赖
    this.autonomousOrchestrator = options.autonomousOrchestrator;
    // EAG-P3 批次 11 S3：CLI 命令解析器赋值（默认 new EagCommandParser()，向后兼容）
    this.eagCommandParser = options.eagCommandParser ?? new EagCommandParser();
  }

  /**
   * 创建统一 LLM 客户端（provider 路由入口，B1）
   *
   * provider=anthropic 时返回 Claude 客户端；openai 时返回 OpenAI 包装客户端。
   * 非流式场景（compactSession 后台总结、edit-handler LLM 辅助）与流式场景
   * （activateSession 主对话、identifyMatchingSkillNames 技能匹配）均按 settings
   * 路由，OpenAI 通路保持既有 createChatCompletionStream（零改动），Anthropic
   * 通路走 LLMClient.createMessage/createMessageStream。
   *
   * 凭据缺失时返回 null（对齐旧 createOpenAIClient client:null 的静默降级语义，
   * 调用方直接跳过 LLM 增强逻辑而非抛错）；其余配置错误（如 anthropic 缺
   * API_KEY 之外的场景）由 ProviderFactory fail-fast 抛出。
   *
   * settings 来源：resolveCurrentSettings(this.projectRoot)，与类内既有
   * 用户级+项目级 settings 合并解析链路保持一致（含 provider 字段推断）。
   * 测试可经 SessionManagerOptions.createLLMClient 注入桩实现（函数注入，非 mock 框架）。
   */
  private createLLMClient(): LLMClient | null {
    if (this.createLLMClientOverride) {
      return this.createLLMClientOverride();
    }
    const settings = resolveCurrentSettings(this.projectRoot);
    if (!settings.apiKey) {
      return null;
    }
    return ProviderFactory.create(settings);
  }

  /**
   * @deprecated Use messageConverter.buildMessages directly.
   * Kept for test compatibility.
   */
  buildOpenAIMessages(
    messages: SessionMessage[],
    thinkingEnabled: boolean,
    model: string
  ): ChatCompletionMessageParam[] {
    return this.messageConverter.buildMessages(messages, thinkingEnabled, model);
  }

  async initMcpServers(servers?: Record<string, McpServerConfig>): Promise<void> {
    this.mcpManager.setOnToolsListChanged(() => {
      this.mcpToolDefinitions = this.mcpManager.getMcpToolDefinitions();
    });
    // 设置状态变更回调，通知 UI 更新
    this.mcpManager.setOnStatusChanged(() => {
      this.onMcpStatusChanged?.();
    });
    await this.mcpManager.initialize(servers);
    this.mcpToolDefinitions = this.mcpManager.getMcpToolDefinitions();
  }

  getMcpStatus() {
    return this.mcpManager.getStatus();
  }

  async reconnectMcpServer(name: string, config?: McpServerConfig): Promise<void> {
    await this.mcpManager.reconnect(name, config);
    this.mcpToolDefinitions = this.mcpManager.getMcpToolDefinitions();
  }

  dispose(): void {
    const controller = this.activePromptController;
    if (controller && !controller.signal.aborted) {
      controller.abort();
    }
    this.activePromptController = null;
    for (const sessionController of this.sessionControllers.values()) {
      if (!sessionController.signal.aborted) {
        sessionController.abort();
      }
    }
    this.killLiveProcesses();
    this.sessionControllers.clear();
    this.processTimeoutControls.clear();
    this.mcpManager.disconnect();
  }

  private estimateStreamTokens(text: string): number {
    let tokens = 0;
    for (const char of text) {
      tokens += /[\u3400-\u9fff\uf900-\ufaff]/u.test(char) ? 0.6 : 0.3;
    }
    return tokens;
  }

  private formatEstimatedTokens(tokens: number): string {
    if (tokens <= 0) {
      return "0";
    }

    const roundedTokens = Math.round(tokens);
    if (roundedTokens <= 0) {
      return "0";
    }

    if (roundedTokens < 100) {
      return String(roundedTokens);
    }

    if (roundedTokens < 10000) {
      return `${Number((roundedTokens / 1000).toFixed(1))}k`;
    }

    return `${Math.round(roundedTokens / 1000)}k`;
  }

  private emitLlmStreamProgress(
    requestId: string,
    startedAt: string,
    estimatedTokens: number,
    phase: LlmStreamProgress["phase"],
    sessionId?: string
  ): void {
    this.onLlmStreamProgress?.({
      requestId,
      sessionId,
      startedAt,
      estimatedTokens: Math.round(estimatedTokens),
      formattedTokens: this.formatEstimatedTokens(estimatedTokens),
      phase,
    });
  }

  private isAbortLikeError(error: unknown): boolean {
    if (!(error instanceof Error)) {
      return false;
    }

    return error.name === "AbortError" || error.constructor.name === "APIUserAbortError";
  }

  private throwIfAborted(signal?: AbortSignal | null): void {
    if (!signal?.aborted) {
      return;
    }

    const error = new Error("Request was aborted.");
    error.name = "AbortError";
    throw error;
  }

  private async createChatCompletionStream(
    client: NonNullable<ReturnType<CreateOpenAIClient>["client"]>,
    request: Record<string, unknown>,
    options?: Record<string, unknown>,
    sessionId?: string,
    debug?: ChatCompletionDebugOptions
  ): Promise<{
    choices?: Array<{ message?: Record<string, unknown> }>;
    usage?: ModelUsage | null;
  }> {
    const requestId = crypto.randomUUID();
    const startedAt = new Date().toISOString();
    const startedAtMs = Date.now();
    let estimatedTokens = 0;
    this.emitLlmStreamProgress(requestId, startedAt, estimatedTokens, "start", sessionId);

    const streamRequest = {
      ...request,
      stream: true,
      stream_options: {
        ...(isUsageRecord(request.stream_options) ? request.stream_options : {}),
        include_usage: true,
      },
    };

    let response: unknown;
    try {
      response = await (
        client.chat.completions.create as unknown as (
          body: Record<string, unknown>,
          options?: Record<string, unknown>
        ) => Promise<unknown>
      )(streamRequest, options);
    } catch (error) {
      this.logChatCompletionDebug(debug, {
        timestamp: new Date().toISOString(),
        location: debug?.location ?? "SessionManager.createChatCompletionStream:create",
        requestId,
        sessionId,
        model: typeof request.model === "string" ? request.model : undefined,
        baseURL: debug?.baseURL,
        durationMs: Date.now() - startedAtMs,
        params: { ...debug?.params, options: summarizeCompletionOptions(options) },
        request: streamRequest,
        error: normalizeDebugError(error),
      });
      logApiError({
        timestamp: new Date().toISOString(),
        location: "SessionManager.createChatCompletionStream:create",
        requestId,
        sessionId,
        model: typeof request.model === "string" ? request.model : undefined,
        error: {
          name: error instanceof Error ? error.name : "UnknownError",
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        },
        request: streamRequest,
      });
      this.emitLlmStreamProgress(requestId, startedAt, estimatedTokens, "end", sessionId);
      throw error;
    }

    if (!response || typeof (response as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] !== "function") {
      this.emitLlmStreamProgress(requestId, startedAt, estimatedTokens, "end", sessionId);
      this.logChatCompletionDebug(debug, {
        timestamp: new Date().toISOString(),
        location: debug?.location ?? "SessionManager.createChatCompletionStream",
        requestId,
        sessionId,
        model: typeof request.model === "string" ? request.model : undefined,
        baseURL: debug?.baseURL,
        durationMs: Date.now() - startedAtMs,
        params: { ...debug?.params, options: summarizeCompletionOptions(options) },
        request: streamRequest,
        response,
      });
      return response as { choices?: Array<{ message?: Record<string, unknown> }>; usage?: ModelUsage | null };
    }

    let content = "";
    let reasoningContent = "";
    let refusal: string | null = null;
    let usage: ModelUsage | null = null;
    const responseChunks: unknown[] = [];
    const toolCallsByIndex = new Map<
      number,
      {
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }
    >();

    const trackText = (value: unknown) => {
      if (typeof value !== "string" || value.length === 0) {
        return;
      }
      estimatedTokens += this.estimateStreamTokens(value);
      this.emitLlmStreamProgress(requestId, startedAt, estimatedTokens, "update", sessionId);
    };

    try {
      for await (const chunk of response as AsyncIterable<Record<string, unknown>>) {
        if (debug?.enabled) {
          responseChunks.push(chunk);
        }
        if ("usage" in chunk && chunk.usage != null) {
          usage = chunk.usage as ModelUsage;
        }

        const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
        for (const choice of choices) {
          const delta = isUsageRecord(choice) && isUsageRecord(choice.delta) ? choice.delta : null;
          if (!delta) {
            continue;
          }

          const contentDelta = delta.content;
          if (typeof contentDelta === "string") {
            content += contentDelta;
            trackText(contentDelta);
          }

          const reasoningDelta = delta.reasoning_content ?? delta.reasoning;
          if (typeof reasoningDelta === "string") {
            reasoningContent += reasoningDelta;
            trackText(reasoningDelta);
          }

          if (typeof delta.refusal === "string") {
            refusal = `${refusal ?? ""}${delta.refusal}`;
            trackText(delta.refusal);
          }

          const rawToolCalls = delta.tool_calls;
          if (Array.isArray(rawToolCalls)) {
            for (const rawToolCall of rawToolCalls) {
              if (!isUsageRecord(rawToolCall)) {
                continue;
              }
              const index = typeof rawToolCall.index === "number" ? rawToolCall.index : toolCallsByIndex.size;
              const current = toolCallsByIndex.get(index) ?? {};
              if (typeof rawToolCall.id === "string") {
                current.id = rawToolCall.id;
              }
              if (typeof rawToolCall.type === "string") {
                current.type = rawToolCall.type;
              }
              const rawFunction = isUsageRecord(rawToolCall.function) ? rawToolCall.function : null;
              if (rawFunction) {
                current.function = current.function ?? {};
                if (typeof rawFunction.name === "string") {
                  current.function.name = `${current.function.name ?? ""}${rawFunction.name}`;
                  trackText(rawFunction.name);
                }
                if (typeof rawFunction.arguments === "string") {
                  current.function.arguments = `${current.function.arguments ?? ""}${rawFunction.arguments}`;
                  trackText(rawFunction.arguments);
                }
              }
              toolCallsByIndex.set(index, current);
            }
          }
        }
      }
    } catch (error) {
      this.logChatCompletionDebug(debug, {
        timestamp: new Date().toISOString(),
        location: debug?.location ?? "SessionManager.createChatCompletionStream:stream",
        requestId,
        sessionId,
        model: typeof request.model === "string" ? request.model : undefined,
        baseURL: debug?.baseURL,
        durationMs: Date.now() - startedAtMs,
        params: { ...debug?.params, options: summarizeCompletionOptions(options) },
        request: streamRequest,
        responseChunks,
        error: normalizeDebugError(error),
      });
      logApiError({
        timestamp: new Date().toISOString(),
        location: "SessionManager.createChatCompletionStream:stream",
        requestId,
        sessionId,
        model: typeof request.model === "string" ? request.model : undefined,
        error: {
          name: error instanceof Error ? error.name : "UnknownError",
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        },
        request: streamRequest,
      });
      throw error;
    } finally {
      this.emitLlmStreamProgress(requestId, startedAt, estimatedTokens, "end", sessionId);
    }

    const toolCalls = Array.from(toolCallsByIndex.entries())
      .sort(([left], [right]) => left - right)
      .map(([, toolCall]) => toolCall);
    const normalizedToolCalls = this.normalizeLlmToolCalls(toolCalls);
    const message: Record<string, unknown> = { content };
    if (normalizedToolCalls) {
      message.tool_calls = normalizedToolCalls;
    }
    if (reasoningContent.length > 0) {
      message.reasoning_content = reasoningContent;
    }
    if (refusal != null) {
      message.refusal = refusal;
    }

    const finalResponse = {
      choices: [{ message }],
      usage,
    };
    this.logChatCompletionDebug(debug, {
      timestamp: new Date().toISOString(),
      location: debug?.location ?? "SessionManager.createChatCompletionStream",
      requestId,
      sessionId,
      model: typeof request.model === "string" ? request.model : undefined,
      baseURL: debug?.baseURL,
      durationMs: Date.now() - startedAtMs,
      params: { ...debug?.params, options: summarizeCompletionOptions(options) },
      request: streamRequest,
      responseChunks,
      response: finalResponse,
    });
    return finalResponse;
  }

  /**
   * Anthropic 通路流式聚合（Claude 主对话接入 · 2026-07-18 设计 §3/§4/§5）
   *
   * 消费 LLMClient.createMessageStream 的归一化事件流（text_delta/thinking_delta/
   * tool_call_start/tool_call_delta/tool_call_end/message_end/error），聚合为与
   * createChatCompletionStream 完全一致的 OpenAI 形态返回契约
   * （{choices:[{message:{content, tool_calls?, reasoning_content?, refusal?}}], usage}），
   * 使主循环消费面（content/tool_calls/reasoning_content/refusal/usage）零改动。
   *
   * 横切能力逐一对等 OpenAI 通路（§5）：流式进度 start/update/end、debug 全量记录
   * （responseChunks 记录归一化事件序列，由 location 区分事件形态差异）、
   * logApiError 结构化错误日志、前置 throwIfAborted 与 abort 身份保留（原样 rethrow）。
   *
   * 关键语义规则：
   * - error 事件必须转回抛出（§4.1）：OpenAI 通路流式错误是抛出语义，主循环 catch
   *   据此置 failed/interrupted；provider 层把错误归一化为事件（不抛出），聚合层
   *   若不转回抛出，主循环会把「半段响应 + 错误」误当作正常完成落盘；
   * - 工具调用桶按 id 索引（Anthropic toolu_* id 唯一），Map 插入序 = 事件出现序，
   *   对等 OpenAI 侧 index 排序后的语义；孤立 tool_call_delta 直接丢弃（§4.2）；
   * - 无参工具空 arguments 兜底 "{}"（executor JSON.parse("") 必败）；非空 arguments
   *   不做 JSON 合法性校验——异常截断时下游 InputParseError 自恢复，与 OpenAI 通路同语义；
   * - 聚合产物形态与 normalizeLlmToolCalls 输入契约一致，多轮回放闭环由
   *   AnthropicMessageConverter.extractToolCalls 原样读回 messageParams.tool_calls 保证。
   *
   * 有意不对等：OpenAI 侧的 Symbol.asyncIterator 非流式回退是其测试基建产物，
   * LLMClient.createMessageStream 契约保证必返回 AsyncIterable，此处不照搬（避免死代码）。
   */
  private async createLlmMessageStream(
    llmClient: LLMClient,
    request: {
      messages: SessionMessage[];
      tools?: LLMToolDefinition[];
      thinkingEnabled: boolean;
      signal?: AbortSignal | null;
    },
    sessionId?: string,
    debug?: ChatCompletionDebugOptions
  ): Promise<{
    choices?: Array<{ message?: Record<string, unknown> }>;
    usage?: ModelUsage | null;
  }> {
    const requestId = crypto.randomUUID();
    const startedAt = new Date().toISOString();
    const startedAtMs = Date.now();
    let estimatedTokens = 0;

    // 前置 abort 守卫（对齐 OpenAI 通路 throwIfAborted 语义）：
    // 必须先于 progress start 发出，否则已中止信号会留下无 end 的孤对 progress
    this.throwIfAborted(request.signal);

    this.emitLlmStreamProgress(requestId, startedAt, estimatedTokens, "start", sessionId);

    // debug/error 日志共用的请求快照：不含 signal（对齐 OpenAI 侧 request 不含 signal 的现状）
    const logRequest: Record<string, unknown> = {
      provider: llmClient.providerName,
      model: llmClient.model,
      baseURL: llmClient.baseURL,
      messages: request.messages,
      tools: request.tools,
      thinkingEnabled: request.thinkingEnabled,
    };

    let content = "";
    let reasoningContent = "";
    let refusal: string | null = null;
    let usage: ModelUsage | null = null;
    const responseChunks: unknown[] = [];
    // 工具调用桶：按 id 索引（provider 层保证 start → delta* → end 顺序），
    // 同时天然支持任意交错序列，不做「同时只有一个活跃桶」假设（§4.2 规则 1/3）
    const toolCallBuckets = new Map<
      string,
      { id: string; type: string; function: { name: string; arguments: string } }
    >();

    // token 估算追踪：text/thinking/工具名/arguments 四类增量（对等 OpenAI 侧五类中的适用项）
    const trackText = (value: string) => {
      if (value.length === 0) {
        return;
      }
      estimatedTokens += this.estimateStreamTokens(value);
      this.emitLlmStreamProgress(requestId, startedAt, estimatedTokens, "update", sessionId);
    };

    try {
      for await (const event of llmClient.createMessageStream({
        messages: request.messages,
        tools: request.tools,
        thinkingEnabled: request.thinkingEnabled,
        signal: request.signal ?? null,
      })) {
        if (debug?.enabled) {
          responseChunks.push(event);
        }
        switch (event.type) {
          case "text_delta":
            content += event.text;
            trackText(event.text);
            break;
          case "thinking_delta":
            reasoningContent += event.thinking;
            trackText(event.thinking);
            break;
          case "tool_call_start":
            toolCallBuckets.set(event.id, {
              id: event.id,
              type: "function",
              function: { name: event.name, arguments: "" },
            });
            trackText(event.name);
            break;
          case "tool_call_delta": {
            const bucket = toolCallBuckets.get(event.id);
            // 孤立 delta（查无此 id）直接丢弃：provider 层已守卫，此处聚合层双保险；
            // 不新建无名桶（name 缺失会污染下游权限解析）（§4.2 规则 2）
            if (bucket) {
              bucket.function.arguments += event.argumentsJsonDelta;
              trackText(event.argumentsJsonDelta);
            }
            break;
          }
          case "tool_call_end": {
            const bucket = toolCallBuckets.get(event.id);
            // 空 arguments 兜底 "{}"：Claude 无参工具语义等价空对象（§4.2 规则 4）
            if (bucket && bucket.function.arguments === "") {
              bucket.function.arguments = "{}";
            }
            break;
          }
          case "message_end":
            usage = toModelUsage(event.usage);
            // refusal 映射（§4.3）：Claude 的拒绝说明文本在 text 块中（即已聚合 content），
            // 直接复用；空内容极端情况给确定性兜底文案，避免 failed 状态无原因
            if (event.stopReason === "refusal") {
              refusal = content.trim().length > 0 ? content : "模型拒绝回答（Claude stop_reason: refusal）";
            }
            break;
          case "error":
            // error 事件转回抛出（§4.1）：原样 rethrow，不包装、不改 name，
            // 保留 name 与 constructor.name 供主循环 isAbortLikeError 判定 abort 语义；
            // 记录 debug + logApiError 由下方 catch 统一完成（与流中直接抛出的异常同路径）
            throw event.error;
        }
      }
    } catch (error) {
      this.logChatCompletionDebug(debug, {
        timestamp: new Date().toISOString(),
        location: debug?.location ?? "SessionManager.createLlmMessageStream",
        requestId,
        sessionId,
        model: llmClient.model,
        baseURL: debug?.baseURL,
        durationMs: Date.now() - startedAtMs,
        params: debug?.params,
        request: logRequest,
        responseChunks,
        error: normalizeDebugError(error),
      });
      logApiError({
        timestamp: new Date().toISOString(),
        location: "SessionManager.createLlmMessageStream",
        requestId,
        sessionId,
        model: llmClient.model,
        error: {
          name: error instanceof Error ? error.name : "UnknownError",
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        },
        request: logRequest,
      });
      throw error;
    } finally {
      // finally 进度 end 照发（对齐 OpenAI 路径正常/异常/abort 均发 end 的行为）
      this.emitLlmStreamProgress(requestId, startedAt, estimatedTokens, "end", sessionId);
    }

    // 桶按 Map 插入序迭代 = 事件出现序，即对等 OpenAI 侧 index 排序后的语义；
    // 返回前过一次 normalizeLlmToolCalls（对齐 OpenAI 侧 L754）：Anthropic id 必然存在，
    // 实际不触发补 id 逻辑，仅为两通路返回体语义严格一致
    const normalizedToolCalls = this.normalizeLlmToolCalls(Array.from(toolCallBuckets.values()));
    const message: Record<string, unknown> = { content };
    if (normalizedToolCalls) {
      message.tool_calls = normalizedToolCalls;
    }
    if (reasoningContent.length > 0) {
      message.reasoning_content = reasoningContent;
    }
    if (refusal != null) {
      message.refusal = refusal;
    }

    const finalResponse = {
      choices: [{ message }],
      usage,
    };
    this.logChatCompletionDebug(debug, {
      timestamp: new Date().toISOString(),
      location: debug?.location ?? "SessionManager.createLlmMessageStream",
      requestId,
      sessionId,
      model: llmClient.model,
      baseURL: debug?.baseURL,
      durationMs: Date.now() - startedAtMs,
      params: debug?.params,
      request: logRequest,
      responseChunks,
      response: finalResponse,
    });
    return finalResponse;
  }

  private logChatCompletionDebug(
    debug: ChatCompletionDebugOptions | undefined,
    entry: Parameters<typeof logOpenAIChatCompletionDebug>[0]
  ): void {
    if (!debug?.enabled) {
      return;
    }
    logOpenAIChatCompletionDebug(entry);
  }

  async identifyMatchingSkillNames(
    skills: SkillInfo[],
    userPrompt: string,
    options?: { signal?: AbortSignal; sessionId?: string }
  ): Promise<string[]> {
    this.throwIfAborted(options?.signal);
    let systemPrompt = `When users ask you to perform tasks, check if any of the available skills match the goal and situation. Skills provide specialized capabilities and domain knowledge.\n
Response in JSON format:
\`\`\`
{
  "skillNames": ["", ...]
}
\`\`\`\n
If none of the available skills match, respond with an empty array, i.e. \`{"skillNames": []}\`.\n
`;
    const simpleSkills = skills
      .filter((x) => !x.isLoaded && x.allowImplicitInvocation !== false)
      .map((x) => {
        return { name: x.name, description: x.description };
      });
    if (simpleSkills.length === 0) {
      return [];
    }
    const candidateSkillNames = new Set(simpleSkills.map((skill) => skill.name));

    const { client, model, baseURL, debugLogEnabled } = this.createOpenAIClient();
    // Claude 技能匹配接入（2026-07-18 设计 §6.2）：provider 判定取 llmClient.providerName
    // 单一事实源（与主循环同口径，测试可经 createLLMClient 注入桩）。
    // anthropicClient 为 null 时走既有 OpenAI 分支（其内部 !client → return [] 语义不变）
    const llmClient = this.createLLMClient();
    const anthropicClient = llmClient?.providerName === "anthropic" ? llmClient : null;
    if (!anthropicClient && !client) {
      return [];
    }

    const agentInstructions = this.loadAgentInstructions();
    if (agentInstructions) {
      systemPrompt += `Use the current agent instructions as additional context when deciding which skills match:\n
<agent-instructions>
${agentInstructions}
</agent-instructions>\n
`;
    }
    systemPrompt += "The candidate skills are as follows:\n\n";
    systemPrompt += "```\n" + JSON.stringify(simpleSkills, null, 2) + "\n```";

    try {
      let content = "";
      if (anthropicClient) {
        // Anthropic 通路：非流式 createMessage（结果被整体 JSON.parse，无增量消费，流式零价值）；
        // 合成 SessionMessage[]（system + user 两条），字段填法参照 compactSession 的合成消息。
        // response_format 放弃（Claude 无此概念，prompt 已明确要求 JSON 输出；解析侧既有
        // 白名单过滤 + JSON.parse 容错构成完整兜底）；temperature 省略（Claude 忽略并告警，
        // 避免误导性告警噪声）；thinkingEnabled 关闭（低延迟分类任务不承担 thinking 开销，
        // 对齐 OpenAI 侧该调用本就不携带 thinking 参数的现状）。
        const skillSessionId = options?.sessionId ?? "skill-matching";
        const messageTime = new Date().toISOString();
        const buildSkillMessage = (role: SessionMessage["role"], messageContent: string): SessionMessage => ({
          id: crypto.randomUUID(),
          sessionId: skillSessionId,
          role,
          content: messageContent,
          contentParams: null,
          messageParams: null,
          compacted: false,
          visible: false,
          createTime: messageTime,
          updateTime: messageTime,
        });
        const llmResponse = await anthropicClient.createMessage({
          messages: [buildSkillMessage("system", systemPrompt), buildSkillMessage("user", userPrompt)],
          thinkingEnabled: false,
          signal: options?.signal ?? null,
        });
        this.throwIfAborted(options?.signal);
        content = llmResponse.content;
      } else if (client) {
        const response = await this.createChatCompletionStream(
          client,
          {
            model,
            temperature: 0.1,
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: userPrompt },
            ],
            response_format: { type: "json_object" },
          },
          options?.signal ? { signal: options.signal } : undefined,
          options?.sessionId,
          {
            enabled: debugLogEnabled,
            location: "SessionManager.identifyMatchingSkillNames",
            baseURL,
            params: { purpose: "skill-matching", temperature: 0.1 },
          }
        );
        this.throwIfAborted(options?.signal);

        const rawContent = response.choices?.[0]?.message?.content;
        content = typeof rawContent === "string" ? rawContent : "";
      }
      if (!content) {
        return [];
      }

      const parsed = JSON.parse(content);
      if (parsed && Array.isArray(parsed.skillNames)) {
        return parsed.skillNames.filter(
          (skillName: unknown): skillName is string =>
            typeof skillName === "string" && candidateSkillNames.has(skillName)
        );
      }

      return [];
    } catch (error) {
      if (this.isAbortLikeError(error) || options?.signal?.aborted) {
        throw error;
      }
      return [];
    }
  }

  private getSkillScanRoots(): Array<{ root: string; displayRoot: string }> {
    const homeDir = os.homedir();
    return [
      { root: path.join(this.projectRoot, ".deepcode", "skills"), displayRoot: "./.deepcode/skills" },
      { root: path.join(this.projectRoot, ".agents", "skills"), displayRoot: "./.agents/skills" },
      { root: path.join(homeDir, ".deepcode", "skills"), displayRoot: "~/.deepcode/skills" },
      { root: path.join(homeDir, ".agents", "skills"), displayRoot: "~/.agents/skills" },
      { root: this.getBundledSkillsRoot(), displayRoot: "bundled:" },
    ];
  }

  private getBundledSkillsRoot(): string {
    const extensionRoot = getExtensionRoot();
    const sourceRoot = path.join(extensionRoot, "templates", "skills", "bundled");

    // Source check keeps local development/tests on the checked-in templates.
    if (fs.existsSync(path.join(extensionRoot, "src", "session.ts")) && fs.existsSync(sourceRoot)) {
      return sourceRoot;
    }

    // In the published bundle, getExtensionRoot() resolves to dist/ and
    // bundled skills are copied to dist/bundled/ (not dist/templates/skills/bundled/).
    const distRoot = path.join(extensionRoot, "bundled");
    return fs.existsSync(distRoot) ? distRoot : sourceRoot;
  }

  async listSkills(sessionId?: string): Promise<SkillInfo[]> {
    const skillRoots = this.getSkillScanRoots();
    const enabledSkills = this.getResolvedSettings().enabledSkills ?? {};
    const skillsByName = new Map<string, SkillInfo>();

    const collectSkills = (root: string, displayRoot: string): SkillInfo[] => {
      if (!fs.existsSync(root)) {
        return [];
      }
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(root, { withFileTypes: true });
      } catch {
        return [];
      }

      const results: SkillInfo[] = [];
      for (const entry of entries) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) {
          continue;
        }
        const skillName = entry.name;
        const skillPath = path.join(root, skillName, "SKILL.md");
        try {
          if (!fs.existsSync(skillPath)) {
            continue;
          }
          const stat = fs.statSync(skillPath);
          if (!stat.isFile()) {
            continue;
          }
        } catch {
          continue;
        }
        const displayPath =
          displayRoot === "bundled:" ? `bundled:${skillName}/SKILL.md` : `${displayRoot}/${skillName}/SKILL.md`;
        const skill = this.readSkillInfo(skillPath, displayPath, skillName);
        if (enabledSkills[skill.name] === false) {
          continue;
        }
        results.push(skill);
      }
      return results;
    };

    for (const { root, displayRoot } of skillRoots) {
      for (const skill of collectSkills(root, displayRoot)) {
        if (!skillsByName.has(skill.name)) {
          skillsByName.set(skill.name, skill);
        }
      }
    }

    if (sessionId) {
      const loadedSkillKeys = this.getLoadedSkillKeys(sessionId);
      for (const skill of skillsByName.values()) {
        if (loadedSkillKeys.has(this.getSkillKey(skill)) || loadedSkillKeys.has(this.getSkillKeyByName(skill.name))) {
          skill.isLoaded = true;
        }
      }
    }

    return Array.from(skillsByName.values()).sort((a, b) => a.name.localeCompare(b.name));
  }

  private resolveSkillPath(skillPath: string): string {
    if (skillPath.startsWith("bundled:")) {
      const relativePath = skillPath.slice("bundled:".length);
      const root = this.getBundledSkillsRoot();
      const resolvedPath = path.resolve(root, relativePath);
      const resolvedRoot = path.resolve(root);
      if (resolvedPath === resolvedRoot || !resolvedPath.startsWith(`${resolvedRoot}${path.sep}`)) {
        return path.join(root, "__invalid_bundled_skill__");
      }
      return resolvedPath;
    }
    if (skillPath.startsWith("~/")) {
      return path.join(os.homedir(), skillPath.slice(2));
    }
    if (skillPath.startsWith("~\\")) {
      return path.join(os.homedir(), skillPath.slice(2));
    }
    if (skillPath.startsWith("./")) {
      return path.join(this.projectRoot, skillPath.slice(2));
    }
    if (skillPath.startsWith(".\\")) {
      return path.join(this.projectRoot, skillPath.slice(2));
    }
    if (path.isAbsolute(skillPath)) {
      return skillPath;
    }
    return path.join(os.homedir(), skillPath);
  }

  private buildSkillPrompt(skill: SkillInfo): string {
    const skillPath = this.resolveSkillPath(skill.path);
    return buildSkillDocumentsPrompt([
      {
        name: skill.name,
        content: fs.readFileSync(skillPath, "utf8"),
        path: skillPath,
        skillFilePath: skillPath,
      },
    ]);
  }

  private readSkillInfo(skillPath: string, displayPath: string, fallbackName: string): SkillInfo {
    const fallbackSkill: SkillInfo = {
      name: fallbackName.replace(/_/g, "-"),
      path: displayPath,
      description: "",
    };

    try {
      const skillMd = fs.readFileSync(skillPath, "utf8");
      const parsed = matter(skillMd);
      const metadata = parsed.data.metadata;
      const allowImplicitInvocation =
        metadata &&
        typeof metadata === "object" &&
        !Array.isArray(metadata) &&
        (metadata as Record<string, unknown>)["allow-implicit-invocation"] === false
          ? false
          : undefined;
      return {
        name:
          typeof parsed.data.name === "string" && parsed.data.name.trim()
            ? parsed.data.name.trim()
            : fallbackSkill.name,
        path: displayPath,
        description: typeof parsed.data.description === "string" ? parsed.data.description.trim() : "",
        allowImplicitInvocation,
      };
    } catch {
      return fallbackSkill;
    }
  }

  private getSkillKey(skill: Pick<SkillInfo, "path">): string {
    return `path:${skill.path}`;
  }

  private getSkillKeyByName(name: string): string {
    return `name:${name}`;
  }

  private getLoadedSkillKeys(sessionId: string): Set<string> {
    const loadedSkillKeys = new Set<string>();
    for (const message of this.listSessionMessages(sessionId)) {
      if (message.role !== "system" || !message.meta?.skill) {
        continue;
      }
      loadedSkillKeys.add(this.getSkillKey(message.meta.skill));
      loadedSkillKeys.add(this.getSkillKeyByName(message.meta.skill.name));
    }
    return loadedSkillKeys;
  }

  private dedupeSkills(skills?: SkillInfo[]): SkillInfo[] | undefined {
    if (!skills || skills.length === 0) {
      return undefined;
    }

    const dedupedSkills = new Map<string, SkillInfo>();
    for (const skill of skills) {
      if (!skill?.name || !skill?.path) {
        continue;
      }
      const key = this.getSkillKey(skill);
      const existingSkill = dedupedSkills.get(key);
      dedupedSkills.set(key, {
        ...existingSkill,
        ...skill,
        description: skill.description ?? existingSkill?.description ?? "",
        isLoaded: Boolean(existingSkill?.isLoaded || skill.isLoaded),
      });
    }

    return Array.from(dedupedSkills.values());
  }

  private async normalizeSkills(skills?: SkillInfo[], sessionId?: string): Promise<SkillInfo[] | undefined> {
    const dedupedSkills = this.dedupeSkills(skills);
    if (!dedupedSkills || dedupedSkills.length === 0) {
      return undefined;
    }

    const availableSkills = await this.listSkills(sessionId);
    const availableSkillsByKey = new Map<string, SkillInfo>();
    for (const skill of availableSkills) {
      availableSkillsByKey.set(this.getSkillKey(skill), skill);
      availableSkillsByKey.set(this.getSkillKeyByName(skill.name), skill);
    }

    return dedupedSkills.map((skill) => {
      const matchedSkill =
        availableSkillsByKey.get(this.getSkillKey(skill)) ??
        availableSkillsByKey.get(this.getSkillKeyByName(skill.name));
      if (!matchedSkill) {
        return skill;
      }
      return {
        ...matchedSkill,
        ...skill,
        description: matchedSkill.description || skill.description,
        isLoaded: Boolean(matchedSkill.isLoaded || skill.isLoaded),
      };
    });
  }

  private appendSkillMessages(sessionId: string, skills?: SkillInfo[]): void {
    if (!skills || skills.length === 0) {
      return;
    }

    for (const skill of skills) {
      if (skill.isLoaded) {
        continue;
      }
      const skillPrompt = this.buildSkillPrompt(skill);
      const skillMessage = this.buildSkillMessage(sessionId, skillPrompt, skill);
      this.appendSessionMessage(sessionId, skillMessage);
      this.onAssistantMessage(skillMessage, true);
    }
  }

  getActiveSessionId(): string | null {
    return this.activeSessionId;
  }

  setActiveSessionId(sessionId: string | null): void {
    this.activeSessionId = sessionId;
  }

  addSessionSystemMessage(sessionId: string, content: string, visible?: boolean, meta?: MessageMeta): void {
    const message = this.buildSystemMessage(sessionId, content, null, visible, meta);
    if (sessionId) this.appendSessionMessage(sessionId, message);
    this.onAssistantMessage(message, false);
  }

  async handleUserPrompt(userPrompt: UserPromptContent): Promise<void> {
    const controller = new AbortController();
    this.activePromptController = controller;

    try {
      if (!this.activeSessionId || !this.getSession(this.activeSessionId)) {
        await this.createSession(userPrompt, controller);
      } else {
        await this.replySession(this.activeSessionId, userPrompt, controller);
      }
    } catch (error) {
      if (!this.isAbortLikeError(error) && !controller.signal.aborted) {
        throw error;
      }
    } finally {
      if (this.activePromptController === controller) {
        this.activePromptController = null;
      }
    }
  }

  async createSession(userPrompt: UserPromptContent, controller?: AbortController): Promise<string> {
    this.reportNewPrompt();
    const signal = controller?.signal;
    this.throwIfAborted(signal);

    const sessionId = crypto.randomUUID();
    this.ensureFileHistorySession(sessionId);
    const now = new Date().toISOString();
    const index = this.loadSessionsIndex();
    const entry: SessionEntry = {
      id: sessionId,
      summary: userPrompt.text ? userPrompt.text.slice(0, 100) : "[Image Prompt]",
      assistantReply: null,
      assistantThinking: null,
      assistantRefusal: null,
      toolCalls: null,
      status: "pending",
      failReason: null,
      usage: null,
      usagePerModel: null,
      activeTokens: 0,
      createTime: now,
      updateTime: now,
      processes: null,
      planMode: Boolean(userPrompt.planMode),
    };
    index.entries.push(entry);
    const sortedEntries = index.entries.slice().sort((a, b) => {
      const aTime = Date.parse(a.updateTime);
      const bTime = Date.parse(b.updateTime);
      if (Number.isNaN(aTime) || Number.isNaN(bTime)) {
        return b.updateTime.localeCompare(a.updateTime);
      }
      return bTime - aTime;
    });
    const keptEntries = sortedEntries.slice(0, MAX_SESSION_ENTRIES);
    const keptIds = new Set(keptEntries.map((item) => item.id));
    const droppedEntries = sortedEntries.filter((item) => !keptIds.has(item.id));
    index.entries = keptEntries;
    this.saveSessionsIndex(index);
    for (const dropped of droppedEntries) {
      this.cleanupSessionResources(dropped.id, {
        removeMessages: true,
        processIds: this.getProcessIds(dropped.processes ?? null),
      });
    }

    const promptToolOptions = this.getPromptToolOptions();
    const systemPrompt = getSystemPrompt(this.projectRoot, promptToolOptions);
    const systemMessage = this.buildSystemMessage(sessionId, systemPrompt);
    this.appendSessionMessage(sessionId, systemMessage);

    const defaultSkillPrompt = getDefaultSkillPrompt({ enabledSkills: this.getResolvedSettings().enabledSkills });
    if (defaultSkillPrompt) {
      const defaultSkillMessage = this.buildSystemMessage(sessionId, defaultSkillPrompt);
      this.appendSessionMessage(sessionId, defaultSkillMessage);
    }

    const runtimeContextMessage = this.buildSystemMessage(
      sessionId,
      getRuntimeContext(this.projectRoot, promptToolOptions.model)
    );
    this.appendSessionMessage(sessionId, runtimeContextMessage);

    const agentInstructions = this.loadAgentInstructions();
    if (agentInstructions) {
      const instructionsMessage = this.buildSystemMessage(sessionId, agentInstructions);
      this.appendSessionMessage(sessionId, instructionsMessage);
    }

    this.appendPlanModeTransitionMessages(sessionId, false, Boolean(userPrompt.planMode));

    this.recordUserPromptCheckpoint(sessionId);
    const userMessage = this.buildUserMessage(sessionId, userPrompt);
    this.appendSessionMessage(sessionId, userMessage);

    if (userPrompt.text) {
      const skills = await this.listSkills();
      const skillNames = await this.identifyMatchingSkillNames(skills, userPrompt.text, { signal });
      this.throwIfAborted(signal);
      const skillSet = new Set(skillNames);
      const matchedSkill = skills.filter((skill) => skillSet.has(skill.name));
      if (Array.isArray(userPrompt.skills)) {
        userPrompt.skills.push(...matchedSkill);
      } else if (matchedSkill.length > 0) {
        userPrompt.skills = matchedSkill;
      }
    }
    userPrompt.skills = await this.normalizeSkills(userPrompt.skills);
    this.throwIfAborted(signal);

    this.appendSkillMessages(sessionId, userPrompt.skills);

    this.activeSessionId = sessionId;
    await this.activateSession(sessionId, controller);
    return sessionId;
  }

  async replySession(sessionId: string, userPrompt: UserPromptContent, controller?: AbortController): Promise<void> {
    const signal = controller?.signal;
    this.throwIfAborted(signal);
    appendProjectPermissionAllows(this.projectRoot, userPrompt.alwaysAllows, {
      inheritedPermissions: this.getResolvedSettings().permissions,
    });
    const now = new Date().toISOString();
    const previousPlanMode = Boolean(this.getSession(sessionId)?.planMode);
    const nextPlanMode = Boolean(userPrompt.planMode);
    const updated = this.updateSessionEntry(sessionId, (entry) => ({
      ...entry,
      status: "pending",
      failReason: null,
      askPermissions: undefined,
      planMode: nextPlanMode,
      updateTime: now,
    }));

    if (!updated) {
      await this.createSession(userPrompt, controller);
      return;
    }

    this.appendPlanModeTransitionMessages(sessionId, previousPlanMode, nextPlanMode);

    if (hasUserPermissionReplies(userPrompt) && this.hasTrailingPendingToolCalls(sessionId)) {
      this.activeSessionId = sessionId;
      await this.activateSession(sessionId, controller, userPrompt);
      return;
    }

    if (this.isContinuePrompt(userPrompt)) {
      this.activeSessionId = sessionId;
      await this.activateSession(sessionId, controller, userPrompt);
      return;
    }

    // EAG-P3 批次 11 S3：统一通过 EagCommandParser 分发 6 个 EAG 命令（§5 S3 改进方案 D-S3-8）
    // 替代原 6 个 isEagXxxPrompt 私有方法 + 6 个 if 分支
    // discriminated union 让 TypeScript 在 switch 分支自动收窄类型，避免类型断言
    // 命令字符串严格匹配（无参数），参数通过 messageParams 注入（D-S3-7）
    // 未注入对应 orchestrator 时各 handle 方法内部通知用户配置缺失（向后兼容）
    const eagCommand = this.eagCommandParser.parse(userPrompt);
    if (eagCommand.kind !== "unknown") {
      this.activeSessionId = sessionId;
      switch (eagCommand.kind) {
        case "eag-build":
          await this.handleEagBuildCommand(sessionId, userPrompt, eagCommand.payload, controller);
          return;
        case "eag-design":
          await this.handleEagDesignCommand(sessionId, userPrompt, eagCommand.payload, controller);
          return;
        case "eag-test":
          await this.handleEagTestCommand(sessionId, userPrompt, eagCommand.payload, controller);
          return;
        case "eag-run":
          await this.handleEagRunCommand(sessionId, userPrompt, eagCommand.payload, controller);
          return;
        case "eag-resume":
          await this.handleEagResumeCommand(sessionId, userPrompt, eagCommand.payload, controller);
          return;
        case "eag-status":
          await this.handleEagStatusCommand(sessionId, userPrompt, eagCommand.payload, controller);
          return;
        case "eag-deploy":
          // EAG-P4 批次 13 Phase 7 §5.2：/eag-deploy 命令分发到 handleEagDeployCommand
          // payload 类型为 DeployRequest | null，由 EagCommandParser.parse() 从
          // userPrompt.messageParams.deployRequest 提取（D-S3-7 注入模式）
          await this.handleEagDeployCommand(sessionId, userPrompt, eagCommand.payload, controller);
          return;
        case "eag-autonomous":
          // EAG-P5 Phase 5.4 TASK-P5-5.4-002：/eag-autonomous 命令分发到 handleEagAutonomousCommand
          // payload 类型为 EagAutonomousRequest | null，由 EagCommandParser.parse() 通过
          // 前缀匹配识别后从 userPrompt.messageParams.autonomousRunRequest 提取（D-S3-7 注入模式）
          // 或从命令字符串内联参数解析（extractEagAutonomousRequestFromPrompt）
          await this.handleEagAutonomousCommand(sessionId, userPrompt, eagCommand.payload, controller);
          return;
        default:
          // 理论不可达（eagCommand.kind !== "unknown" 已过滤兜底分支）
          // 防御性编程：未知 kind 不做处理，落入下方非 EAG 流程
          break;
      }
    }

    // EAG-P3 批次 10：候选规则检测 Hook（§4.18.4 detectRuleCandidateHook）
    // 主对话循环每次用户输入后调用：
    // 1. 调用 ruleLearner.detectCorrection 检测纠正模式
    // 2. 命中纠正模式 → extractCandidate + accumulateCandidate 累积候选
    // 3. shouldPushConfirmation 判定是否推送确认请求（≥2 次才推送，§5.5.4 防误学红线）
    // 4. 推送确认请求 → 用户回复 `/rule-confirm <id>` 后由调用方调用 confirmCandidate
    // 未注入 ruleLearner 时跳过（向后兼容，零开销）
    if (typeof userPrompt.text === "string" && userPrompt.text.trim().length > 0) {
      await this.detectRuleCandidateHook(userPrompt.text, sessionId);
    }

    this.reportNewPrompt();

    this.ensureFileHistorySession(sessionId);
    const checkpoint = this.recordUserPromptCheckpoint(sessionId);
    if (checkpoint.changedFilePaths.length) {
      const content = `Note that the user manually modified these files:\n${checkpoint.changedFilePaths.join("\n")}`;
      this.appendSessionMessage(sessionId, this.buildSystemMessage(sessionId, content));
    }
    const userMessage = this.buildUserMessage(sessionId, userPrompt);
    this.appendSessionMessage(sessionId, userMessage);

    if (userPrompt.text) {
      const skills = await this.listSkills(sessionId);
      const skillNames = await this.identifyMatchingSkillNames(skills, userPrompt.text, { signal, sessionId });
      this.throwIfAborted(signal);
      const skillSet = new Set(skillNames);
      const matchedSkill = skills.filter((skill) => skillSet.has(skill.name));
      if (Array.isArray(userPrompt.skills)) {
        userPrompt.skills.push(...matchedSkill);
      } else if (matchedSkill.length > 0) {
        userPrompt.skills = matchedSkill;
      }
    }
    userPrompt.skills = await this.normalizeSkills(userPrompt.skills, sessionId);
    this.throwIfAborted(signal);

    this.appendSkillMessages(sessionId, userPrompt.skills);
    this.activeSessionId = sessionId;
    await this.activateSession(sessionId, controller);
  }

  private isContinuePrompt(userPrompt: UserPromptContent): boolean {
    return (
      typeof userPrompt.text === "string" &&
      userPrompt.text.trim() === "/continue" &&
      (!userPrompt.imageUrls || userPrompt.imageUrls.length === 0) &&
      (!userPrompt.skills || userPrompt.skills.length === 0)
    );
  }

  /**
   * EAG-P2 批次 9 S5：处理 `/eag-build` 命令，触发 CODING Loop 编排（§4.9.3）
   *
   * EAG-P3 批次 11 S3 改造：request 参数由 EagCommandParser.parse() 预提取后注入（D-S3-7），
   * 不再在本方法内部调用 extractCodingLoopRequest。payload 为 null 时通知用户配置缺失。
   *
   * 算法（对齐 §4.9.3 伪代码 + 架构师关键修正"session.ts 改动最小化"）：
   * 1. 校验外挂依赖：codingOrchestrator + pkcAccessor + loopGuard 必须同时注入
   *    未注入 → 通过 onAssistantMessage 通知用户配置缺失，不抛异常（向后兼容）
   * 2. 校验 CodingLoopRequest（由 EagCommandParser 预提取的 payload）
   *    未提供 payload 时通知用户配置缺失
   * 3. 调用 codingOrchestrator.run(request) 执行 CODING Loop
   *    异常路径：catch 后通知用户错误，更新 session 状态为 failed
   * 4. 渲染结果：通过 onAssistantMessage 发送结果摘要（含 finalStatus + 统计 + blockedReason）
   * 5. 更新 session 状态为 completed/failed（依据 result.finalStatus）
   *
   * 不可变优先（§5.12.4 G-A6d）：
   * - request 字段使用 Readonly 包裹
   * - result 通过 Object.freeze 由 CodingOrchestrator 内部冻结
   *
   * @param sessionId 会话 ID
   * @param userPrompt 用户输入（仅用于写入用户消息历史，不参与编排）
   * @param request 预装配的 CodingLoopRequest（由 EagCommandParser.parse() 提取，可空）
   * @param controller 中断控制器（用于响应 abort 信号）
   */
  private async handleEagBuildCommand(
    sessionId: string,
    userPrompt: UserPromptContent,
    request: CodingLoopRequest | null,
    controller?: AbortController
  ): Promise<void> {
    const signal = controller?.signal;
    this.throwIfAborted(signal);

    const now = new Date().toISOString();
    // 记录用户输入到消息历史（保持会话上下文完整）
    const userMessage = this.buildUserMessage(sessionId, userPrompt);
    this.appendSessionMessage(sessionId, userMessage);

    // 更新 session 状态为 processing
    this.updateSessionEntry(sessionId, (entry) => ({
      ...entry,
      status: "processing",
      failReason: null,
      updateTime: now,
    }));

    // 步骤 1：校验外挂依赖
    if (!this.codingOrchestrator) {
      // 未注入 codingOrchestrator → 通知用户配置缺失，更新 session 状态为 failed
      const errMsg =
        "CODING Loop 编排器未注入：请在 SessionManagerOptions.codingOrchestrator 配置后重启（参考 §4.9.3）";
      this.updateSessionEntry(sessionId, (entry) => ({
        ...entry,
        status: "failed",
        failReason: errMsg,
        updateTime: new Date().toISOString(),
      }));
      this.onAssistantMessage(this.buildAssistantMessage(sessionId, `[EAG CODING Loop] ${errMsg}`, null), false);
      return;
    }
    if (!this.pkcAccessor) {
      const errMsg = "PKC 知识库访问器未注入：请在 SessionManagerOptions.pkcAccessor 配置后重启（参考 §4.9.3）";
      this.updateSessionEntry(sessionId, (entry) => ({
        ...entry,
        status: "failed",
        failReason: errMsg,
        updateTime: new Date().toISOString(),
      }));
      this.onAssistantMessage(this.buildAssistantMessage(sessionId, `[EAG CODING Loop] ${errMsg}`, null), false);
      return;
    }

    // 步骤 2：校验 CodingLoopRequest（EAG-P3 批次 11 S3：payload 由 EagCommandParser 预提取）
    // 调用方负责在创建会话时通过 messageParams 传入 CodingLoopRequest 实例
    // EagCommandParser.parse() 已从 userPrompt.messageParams.codingLoopRequest 提取并完成字段校验
    // payload 为 null 时通知用户配置缺失（保持既有错误提示路径不丢失）
    if (!request) {
      const errMsg =
        "CodingLoopRequest 未提供：请通过 userPrompt.messageParams.codingLoopRequest 传入预装配的编排请求（参考 §4.9.3）";
      this.updateSessionEntry(sessionId, (entry) => ({
        ...entry,
        status: "failed",
        failReason: errMsg,
        updateTime: new Date().toISOString(),
      }));
      this.onAssistantMessage(this.buildAssistantMessage(sessionId, `[EAG CODING Loop] ${errMsg}`, null), false);
      return;
    }

    // 步骤 3：调用 codingOrchestrator.run(request) 执行 CODING Loop
    let result: CodingLoopResult;
    try {
      result = await this.codingOrchestrator.run(request);
    } catch (e) {
      // 编排器异常 → 通知用户错误，更新 session 状态为 failed
      const errMsg = e instanceof Error ? e.message : String(e);
      this.updateSessionEntry(sessionId, (entry) => ({
        ...entry,
        status: "failed",
        failReason: `CODING Loop 编排异常：${errMsg}`,
        updateTime: new Date().toISOString(),
      }));
      this.onAssistantMessage(
        this.buildAssistantMessage(
          sessionId,
          `[EAG CODING Loop] 编排异常：${errMsg}\n请检查依赖组件（SkeletonGenerator/ContextAssembler/LlmFiller/StrictEvaluator/FixLoop/GateG4Checker/GateG5Checker）配置是否正确。`,
          null
        ),
        false
      );
      return;
    }

    // 步骤 4：渲染结果摘要（含 finalStatus + 统计 + blockedReason）
    const summary = this.renderCodingLoopResult(result);
    this.onAssistantMessage(this.buildAssistantMessage(sessionId, summary, null), false);

    // 步骤 5：更新 session 状态（依据 result.finalStatus）
    const isSuccess = result.finalStatus === "completed";
    this.updateSessionEntry(sessionId, (entry) => ({
      ...entry,
      status: isSuccess ? "completed" : "failed",
      failReason: isSuccess ? null : `CODING Loop 终止：${result.blockedReason ?? result.finalStatus}`,
      updateTime: new Date().toISOString(),
    }));
  }

  /**
   * 渲染 CodingLoopResult 为可读的摘要文本（§4.9.3）
   *
   * 渲染内容：
   * - 最终状态（completed/failed/human-checkpoint）
   * - 任务卡执行统计（任务数、迭代次数、LLM 调用次数、token 消耗、耗时）
   * - 各任务卡状态明细（taskCardId → status + verdict）
   * - 失败原因（blockedReason，若存在）
   *
   * @param result CODING Loop 编排产出
   * @returns 可读的摘要文本
   */
  private renderCodingLoopResult(result: Readonly<CodingLoopResult>): string {
    const lines: string[] = [];
    lines.push("[EAG CODING Loop] 编排完成");
    lines.push(`最终状态: ${result.finalStatus}`);
    lines.push(
      `任务卡数: ${result.taskResults.length}，迭代次数: ${result.totalIterations}，` +
        `LLM 调用次数: ${result.totalLlmCallCount}，token 消耗: ${result.totalTokensUsed}，耗时: ${result.durationSec}s`
    );

    // 各任务卡状态明细
    if (result.taskResults.length > 0) {
      lines.push("");
      lines.push("任务卡执行明细:");
      for (const taskResult of result.taskResults) {
        const verdict = taskResult.finalEvaluation?.verdict ?? "n/a";
        lines.push(
          `  - ${taskResult.taskCardId}: status=${taskResult.status}, verdict=${verdict}, ` +
            `iterations=${taskResult.iterations}`
        );
      }
    }

    // 生成文件清单（仅展示前 10 个，避免输出过长）
    if (result.allGeneratedFiles.length > 0) {
      lines.push("");
      lines.push(`生成文件 (${result.allGeneratedFiles.length} 个):`);
      const fileLimit = Math.min(result.allGeneratedFiles.length, 10);
      for (let i = 0; i < fileLimit; i++) {
        lines.push(`  - ${result.allGeneratedFiles[i].relativePath}`);
      }
      if (result.allGeneratedFiles.length > fileLimit) {
        lines.push(`  ...（其余 ${result.allGeneratedFiles.length - fileLimit} 个文件已省略）`);
      }
    }

    // 失败原因
    if (result.blockedReason) {
      lines.push("");
      lines.push(`终止原因: ${result.blockedReason}`);
    }

    return lines.join("\n");
  }

  // ============================================================================
  // EAG-P3 批次 10：/eag-design 命令处理（§4.18.3）
  // ============================================================================

  /**
   * 处理 `/eag-design` 命令，触发 DESIGN Loop 编排（§4.18.3）
   *
   * EAG-P3 批次 11 S3 改造：input 参数由 EagCommandParser.parse() 预提取后注入（D-S3-7），
   * 不再在本方法内部调用 extractDesignLoopInput。payload 为 null 时通知用户配置缺失。
   *
   * 算法（对齐 §4.18.3 + 复用 handleEagBuildCommand 既有模式）：
   * 1. 校验外挂依赖：designOrchestrator 必须注入
   *    未注入 → 通知用户配置缺失，更新 session 状态为 failed（向后兼容）
   * 2. 校验 DesignLoopInput（由 EagCommandParser 预提取的 payload）
   *    未提供 payload → 通知用户配置缺失
   * 3. 调用 designOrchestrator.run(input) 执行 DESIGN Loop
   *    异常路径：catch 后通知用户错误，更新 session 状态为 failed
   * 4. 渲染结果：通过 onAssistantMessage 发送结果摘要（含 evaluationVerdict + iterations）
   * 5. 更新 session 状态为 completed/failed（依据 evaluationVerdict.passed）
   *
   * 不可变优先（§5.12.4 G-A6d）：
   * - input 字段使用 Readonly 包裹
   * - result 通过 Object.freeze 由 DesignLoopOrchestrator 内部冻结
   *
   * @param sessionId 会话 ID
   * @param userPrompt 用户输入（仅用于写入用户消息历史，不参与编排）
   * @param input 预装配的 DesignLoopInput（由 EagCommandParser.parse() 提取，可空）
   * @param controller 中断控制器（用于响应 abort 信号）
   */
  private async handleEagDesignCommand(
    sessionId: string,
    userPrompt: UserPromptContent,
    input: DesignLoopInput | null,
    controller?: AbortController
  ): Promise<void> {
    const signal = controller?.signal;
    this.throwIfAborted(signal);

    const now = new Date().toISOString();
    // 记录用户输入到消息历史（保持会话上下文完整）
    const userMessage = this.buildUserMessage(sessionId, userPrompt);
    this.appendSessionMessage(sessionId, userMessage);

    // 更新 session 状态为 processing
    this.updateSessionEntry(sessionId, (entry) => ({
      ...entry,
      status: "processing",
      failReason: null,
      updateTime: now,
    }));

    // 步骤 1：校验外挂依赖
    if (!this.designOrchestrator) {
      const errMsg =
        "DESIGN Loop 编排器未注入：请在 SessionManagerOptions.designOrchestrator 配置后重启（参考 §4.18.3）";
      this.updateSessionEntry(sessionId, (entry) => ({
        ...entry,
        status: "failed",
        failReason: errMsg,
        updateTime: new Date().toISOString(),
      }));
      this.onAssistantMessage(this.buildAssistantMessage(sessionId, `[EAG DESIGN Loop] ${errMsg}`, null), false);
      return;
    }

    // 步骤 2：校验 DesignLoopInput（EAG-P3 批次 11 S3：payload 由 EagCommandParser 预提取）
    // EagCommandParser.parse() 已从 userPrompt.messageParams.designLoopInput 提取并完成字段校验
    // payload 为 null 时通知用户配置缺失（保持既有错误提示路径不丢失）
    if (!input) {
      const errMsg =
        "DesignLoopInput 未提供：请通过 userPrompt.messageParams.designLoopInput 传入预装配的编排输入（参考 §4.18.3）";
      this.updateSessionEntry(sessionId, (entry) => ({
        ...entry,
        status: "failed",
        failReason: errMsg,
        updateTime: new Date().toISOString(),
      }));
      this.onAssistantMessage(this.buildAssistantMessage(sessionId, `[EAG DESIGN Loop] ${errMsg}`, null), false);
      return;
    }

    // 步骤 3：调用 designOrchestrator.run(input) 执行 DESIGN Loop
    let result: DesignLoopResult;
    try {
      result = await this.designOrchestrator.run(input);
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      this.updateSessionEntry(sessionId, (entry) => ({
        ...entry,
        status: "failed",
        failReason: `DESIGN Loop 编排异常：${errMsg}`,
        updateTime: new Date().toISOString(),
      }));
      this.onAssistantMessage(
        this.buildAssistantMessage(
          sessionId,
          `[EAG DESIGN Loop] 编排异常：${errMsg}\n请检查依赖组件（ProductManagerProtocol/ArchitectProtocol/DesignEvaluatorProtocol）配置是否正确。`,
          null
        ),
        false
      );
      return;
    }

    // 步骤 4：渲染结果摘要
    const summary = this.renderDesignLoopResult(result);
    this.onAssistantMessage(this.buildAssistantMessage(sessionId, summary, null), false);

    // 步骤 5：更新 session 状态（依据 evaluationVerdict.passed）
    const isSuccess = result.evaluationVerdict.passed;
    this.updateSessionEntry(sessionId, (entry) => ({
      ...entry,
      status: isSuccess ? "completed" : "failed",
      failReason: isSuccess ? null : `DESIGN Loop 终止：${result.evaluationVerdict.reason}`,
      updateTime: new Date().toISOString(),
    }));
  }

  /**
   * 渲染 DesignLoopResult 为可读的摘要文本（§4.18.3）
   *
   * 渲染内容：
   * - 评估器判定结果（passed/failed + reason + severity + findings）
   * - 迭代次数（评估失败重试次数）
   * - 是否触发人工检查点
   * - 产出物摘要（架构文档 + 领域模型文档的元信息）
   *
   * @param result DESIGN Loop 编排产出
   * @returns 可读的摘要文本
   */
  private renderDesignLoopResult(result: Readonly<DesignLoopResult>): string {
    const lines: string[] = [];
    lines.push("[EAG DESIGN Loop] 编排完成");
    const verdictPassed = result.evaluationVerdict.passed ? "通过" : "未通过";
    lines.push(`评估结果: ${verdictPassed}（severity=${result.evaluationVerdict.severity}）`);
    lines.push(`迭代次数: ${result.iterations}`);
    lines.push(`人工检查点已触发: ${result.humanCheckpointTriggered ? "是" : "否"}`);
    lines.push(`判定理由: ${result.evaluationVerdict.reason}`);

    // findings 列表（评估器发现的问题清单）
    if (result.evaluationVerdict.findings.length > 0) {
      lines.push("");
      lines.push("评估器发现的问题:");
      for (const finding of result.evaluationVerdict.findings) {
        lines.push(`  - ${finding}`);
      }
    }

    // 建议修复方案
    if (result.evaluationVerdict.suggestedFix) {
      lines.push("");
      lines.push(`建议修复方案: ${result.evaluationVerdict.suggestedFix}`);
    }

    return lines.join("\n");
  }

  // ============================================================================
  // EAG-P3 批次 10：/eag-test 命令处理（§4.18.3）
  // ============================================================================

  /**
   * 处理 `/eag-test` 命令，触发 TESTING Loop 编排（§4.18.3）
   *
   * EAG-P3 批次 11 S3 改造：request 参数由 EagCommandParser.parse() 预提取后注入（D-S3-7），
   * 不再在本方法内部调用 extractTestingLoopRequest。payload 为 null 时通知用户配置缺失。
   *
   * 算法（对齐 §4.18.3 + 复用 handleEagBuildCommand 既有模式）：
   * 1. 校验外挂依赖：testingOrchestrator 必须注入
   *    未注入 → 通知用户配置缺失，更新 session 状态为 failed（向后兼容）
   * 2. 校验 TestingLoopRequest（由 EagCommandParser 预提取的 payload）
   *    未提供 payload → 通知用户配置缺失
   * 3. 调用 testingOrchestrator.run(request) 执行 TESTING Loop
   *    异常路径：catch 后通知用户错误，更新 session 状态为 failed
   * 4. 渲染结果：通过 onAssistantMessage 发送结果摘要（含 finalStatus + 测试文件清单 + 覆盖率报告）
   * 5. 更新 session 状态为 completed/failed（依据 result.finalStatus === "success"）
   *
   * @param sessionId 会话 ID
   * @param userPrompt 用户输入（仅用于写入用户消息历史，不参与编排）
   * @param request 预装配的 TestingLoopRequest（由 EagCommandParser.parse() 提取，可空）
   * @param controller 中断控制器（用于响应 abort 信号）
   */
  private async handleEagTestCommand(
    sessionId: string,
    userPrompt: UserPromptContent,
    request: TestingLoopRequest | null,
    controller?: AbortController
  ): Promise<void> {
    const signal = controller?.signal;
    this.throwIfAborted(signal);

    const now = new Date().toISOString();
    const userMessage = this.buildUserMessage(sessionId, userPrompt);
    this.appendSessionMessage(sessionId, userMessage);

    this.updateSessionEntry(sessionId, (entry) => ({
      ...entry,
      status: "processing",
      failReason: null,
      updateTime: now,
    }));

    // 步骤 1：校验外挂依赖
    if (!this.testingOrchestrator) {
      const errMsg =
        "TESTING Loop 编排器未注入：请在 SessionManagerOptions.testingOrchestrator 配置后重启（参考 §4.18.3）";
      this.updateSessionEntry(sessionId, (entry) => ({
        ...entry,
        status: "failed",
        failReason: errMsg,
        updateTime: new Date().toISOString(),
      }));
      this.onAssistantMessage(this.buildAssistantMessage(sessionId, `[EAG TESTING Loop] ${errMsg}`, null), false);
      return;
    }

    // 步骤 2：校验 TestingLoopRequest（EAG-P3 批次 11 S3：payload 由 EagCommandParser 预提取）
    // EagCommandParser.parse() 已从 userPrompt.messageParams.testingLoopRequest 提取并完成字段校验
    // payload 为 null 时通知用户配置缺失（保持既有错误提示路径不丢失）
    if (!request) {
      const errMsg =
        "TestingLoopRequest 未提供：请通过 userPrompt.messageParams.testingLoopRequest 传入预装配的编排请求（参考 §4.18.3）";
      this.updateSessionEntry(sessionId, (entry) => ({
        ...entry,
        status: "failed",
        failReason: errMsg,
        updateTime: new Date().toISOString(),
      }));
      this.onAssistantMessage(this.buildAssistantMessage(sessionId, `[EAG TESTING Loop] ${errMsg}`, null), false);
      return;
    }

    // 步骤 3：调用 testingOrchestrator.run(request) 执行 TESTING Loop
    let result: TestingLoopResult;
    try {
      result = await this.testingOrchestrator.run(request);
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      this.updateSessionEntry(sessionId, (entry) => ({
        ...entry,
        status: "failed",
        failReason: `TESTING Loop 编排异常：${errMsg}`,
        updateTime: new Date().toISOString(),
      }));
      this.onAssistantMessage(
        this.buildAssistantMessage(
          sessionId,
          `[EAG TESTING Loop] 编排异常：${errMsg}\n请检查依赖组件（ContractTestGenerator/E2eTestGenerator/CoverageGate/BrownfieldContractGuard）配置是否正确。`,
          null
        ),
        false
      );
      return;
    }

    // 步骤 4：渲染结果摘要
    const summary = this.renderTestingLoopResult(result);
    this.onAssistantMessage(this.buildAssistantMessage(sessionId, summary, null), false);

    // 步骤 5：更新 session 状态（依据 result.finalStatus === "success"）
    const isSuccess = result.finalStatus === "success";
    this.updateSessionEntry(sessionId, (entry) => ({
      ...entry,
      status: isSuccess ? "completed" : "failed",
      failReason: isSuccess ? null : `TESTING Loop 终止：${result.blockedReason ?? result.finalStatus}`,
      updateTime: new Date().toISOString(),
    }));
  }

  /**
   * 渲染 TestingLoopResult 为可读的摘要文本（§4.18.3）
   *
   * 渲染内容：
   * - 最终状态（success/human_checkpoint/stop_failure）
   * - 测试文件统计（契约/E2E/集成/合规）
   * - 覆盖率报告摘要（lines/branches/functions）
   * - 总耗时与 token 消耗
   * - 阻塞原因（若存在）
   *
   * @param result TESTING Loop 编排产出
   * @returns 可读的摘要文本
   */
  private renderTestingLoopResult(result: Readonly<TestingLoopResult>): string {
    const lines: string[] = [];
    lines.push("[EAG TESTING Loop] 编排完成");
    lines.push(`最终状态: ${result.finalStatus}`);
    lines.push(
      `测试文件数: 契约=${result.contractTests.length}, E2E=${result.e2eTests.length}, ` +
        `集成=${result.integrationTests.length}, 合规=${result.complianceTests.length}`
    );

    // 覆盖率报告摘要
    const cov = result.coverageReport;
    lines.push(
      `覆盖率: lines=${cov.lines}%, branches=${cov.branches}%, functions=${cov.functions}%, highRiskSymbols=${cov.highRiskSymbols}%`
    );

    // 总耗时与 token 消耗
    lines.push(
      `LLM 调用次数: ${result.totalLlmCallCount}，token 消耗: ${result.totalTokensUsed}，耗时: ${result.durationSec}s`
    );

    // 生成文件清单（仅展示前 10 个，避免输出过长）
    const allFiles = [
      ...result.contractTests,
      ...result.e2eTests,
      ...result.integrationTests,
      ...result.complianceTests,
    ];
    if (allFiles.length > 0) {
      lines.push("");
      lines.push(`生成测试文件 (${allFiles.length} 个):`);
      const fileLimit = Math.min(allFiles.length, 10);
      for (let i = 0; i < fileLimit; i++) {
        lines.push(`  - ${allFiles[i].relativePath}`);
      }
      if (allFiles.length > fileLimit) {
        lines.push(`  ...（其余 ${allFiles.length - fileLimit} 个文件已省略）`);
      }
    }

    // 阻塞原因
    if (result.blockedReason) {
      lines.push("");
      lines.push(`终止原因: ${result.blockedReason}`);
    }

    return lines.join("\n");
  }

  // ============================================================================
  // EAG-P3 批次 10：/eag-run 命令处理（§4.18.3）
  // ============================================================================

  /**
   * 处理 `/eag-run` 命令，触发长程自动化多 Loop 串联编排（§4.18.3）
   *
   * EAG-P3 批次 11 S3 改造：request 参数由 EagCommandParser.parse() 预提取后注入（D-S3-7），
   * 不再在本方法内部调用 extractEagRunRequest。payload 为 null 时通知用户配置缺失。
   *
   * 算法（对齐 §4.18.3 + 复用 handleEagBuildCommand 既有模式）：
   * 1. 校验外挂依赖：runStateStore 必须注入
   *    未注入 → 通知用户配置缺失，更新 session 状态为 failed（向后兼容）
   * 2. 校验 EagRunRequest（由 EagCommandParser 预提取的 payload）
   *    未提供 payload → 通知用户配置缺失
   * 3. 构造 EagRunHandler（内部 new MultiLoopPlanner / MilestoneTagger / BlockageAnalyzer，
   *    共享注入的 runStateStore 实例）
   * 4. 调用 handler.handle(request) 执行多 Loop 串联
   *    异常路径：catch 后通知用户错误，更新 session 状态为 failed
   * 5. 渲染结果：通过 onAssistantMessage 发送结果摘要（含 finalStatus + 里程碑 + 阻塞分析）
   * 6. 更新 session 状态为 completed/failed（依据 result.finalStatus === "completed"）
   *
   * @param sessionId 会话 ID
   * @param userPrompt 用户输入（仅用于写入用户消息历史，不参与编排）
   * @param request 预装配的 EagRunRequest（由 EagCommandParser.parse() 提取，可空）
   * @param controller 中断控制器（用于响应 abort 信号）
   */
  private async handleEagRunCommand(
    sessionId: string,
    userPrompt: UserPromptContent,
    request: EagRunRequest | null,
    controller?: AbortController
  ): Promise<void> {
    const signal = controller?.signal;
    this.throwIfAborted(signal);

    const now = new Date().toISOString();
    const userMessage = this.buildUserMessage(sessionId, userPrompt);
    this.appendSessionMessage(sessionId, userMessage);

    this.updateSessionEntry(sessionId, (entry) => ({
      ...entry,
      status: "processing",
      failReason: null,
      updateTime: now,
    }));

    // 步骤 1：校验外挂依赖
    if (!this.runStateStore) {
      const errMsg = "RunStateStore 未注入：请在 SessionManagerOptions.runStateStore 配置后重启（参考 §4.18.3）";
      this.updateSessionEntry(sessionId, (entry) => ({
        ...entry,
        status: "failed",
        failReason: errMsg,
        updateTime: new Date().toISOString(),
      }));
      this.onAssistantMessage(this.buildAssistantMessage(sessionId, `[EAG RUN] ${errMsg}`, null), false);
      return;
    }

    // 步骤 2：校验 EagRunRequest（EAG-P3 批次 11 S3：payload 由 EagCommandParser 预提取）
    // EagCommandParser.parse() 已从 userPrompt.messageParams.eagRunRequest 提取并完成字段校验
    // payload 为 null 时通知用户配置缺失（保持既有错误提示路径不丢失）
    if (!request) {
      const errMsg =
        "EagRunRequest 未提供：请通过 userPrompt.messageParams.eagRunRequest 传入预装配的命令请求（参考 §4.18.3）";
      this.updateSessionEntry(sessionId, (entry) => ({
        ...entry,
        status: "failed",
        failReason: errMsg,
        updateTime: new Date().toISOString(),
      }));
      this.onAssistantMessage(this.buildAssistantMessage(sessionId, `[EAG RUN] ${errMsg}`, null), false);
      return;
    }

    // 步骤 3：构造 EagRunHandler
    // 注：MultiLoopPlanner / MilestoneTagger / BlockageAnalyzer 在内部按需构造，
    //     共享调用方注入的 runStateStore 实例（保证 run→resume→status 状态一致）
    let handler: EagRunHandler;
    try {
      handler = new EagRunHandler({
        multiLoopPlanner: new MultiLoopPlanner(),
        runStateStore: this.runStateStore,
        milestoneTagger: new MilestoneTagger(this.runStateStore),
        blockageAnalyzer: new BlockageAnalyzer(this.runStateStore),
      });
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      this.updateSessionEntry(sessionId, (entry) => ({
        ...entry,
        status: "failed",
        failReason: `EagRunHandler 构造失败：${errMsg}`,
        updateTime: new Date().toISOString(),
      }));
      this.onAssistantMessage(
        this.buildAssistantMessage(sessionId, `[EAG RUN] 处理器构造失败：${errMsg}`, null),
        false
      );
      return;
    }

    // 步骤 4：调用 handler.handle(request) 执行长程自动化
    let result: EagRunResult;
    try {
      result = await handler.handle(request);
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      this.updateSessionEntry(sessionId, (entry) => ({
        ...entry,
        status: "failed",
        failReason: `EAG Run 编排异常：${errMsg}`,
        updateTime: new Date().toISOString(),
      }));
      this.onAssistantMessage(
        this.buildAssistantMessage(
          sessionId,
          `[EAG RUN] 编排异常：${errMsg}\n请检查 LoopExecutor 配置与 MultiLoopPlanner 计划生成是否正确。`,
          null
        ),
        false
      );
      return;
    }

    // 步骤 5：渲染结果摘要
    const summary = this.renderEagRunResult(result);
    this.onAssistantMessage(this.buildAssistantMessage(sessionId, summary, null), false);

    // 步骤 6：更新 session 状态（依据 result.finalStatus === "completed"）
    const isSuccess = result.finalStatus === "completed";
    this.updateSessionEntry(sessionId, (entry) => ({
      ...entry,
      status: isSuccess ? "completed" : "failed",
      failReason: isSuccess ? null : `EAG Run 终止：${result.blockageReport?.rootCauseHypotheses?.length ?? 0} 个根因`,
      updateTime: new Date().toISOString(),
    }));
  }

  /**
   * 渲染 EagRunResult 为可读的摘要文本（§4.18.3）
   *
   * 渲染内容：
   * - runId（运行 ID，用于 /eag-resume /eag-status 后续查询）
   * - 最终状态（completed/failed/human-checkpoint/paused）
   * - 完成的 Loop 列表
   * - 里程碑数量
   * - 总 LLM 调用次数 / token 消耗 / 耗时
   * - 阻塞报告摘要（若存在）
   *
   * @param result EAG Run 编排产出
   * @returns 可读的摘要文本
   */
  private renderEagRunResult(result: Readonly<EagRunResult>): string {
    const lines: string[] = [];
    lines.push("[EAG RUN] 长程自动化完成");
    lines.push(`runId: ${result.runId}`);
    lines.push(`最终状态: ${result.finalStatus}`);
    lines.push(`完成的 Loop: ${result.completedLoops.length > 0 ? result.completedLoops.join(", ") : "（无）"}`);
    lines.push(`里程碑数: ${result.milestones.length}`);
    lines.push(
      `LLM 调用次数: ${result.totalLlmCallCount}，token 消耗: ${result.totalTokensUsed}，耗时: ${result.durationSec}s`
    );

    // 里程碑列表（仅展示前 5 个，避免输出过长）
    if (result.milestones.length > 0) {
      lines.push("");
      lines.push("里程碑列表:");
      const milestoneLimit = Math.min(result.milestones.length, 5);
      for (let i = 0; i < milestoneLimit; i++) {
        const m = result.milestones[i];
        lines.push(`  - ${m.tagName ?? m.name ?? `milestone-${i + 1}`}`);
      }
      if (result.milestones.length > milestoneLimit) {
        lines.push(`  ...（其余 ${result.milestones.length - milestoneLimit} 个里程碑已省略）`);
      }
    }

    // 阻塞报告摘要
    if (result.blockageReport) {
      lines.push("");
      lines.push("阻塞分析:");
      const rootCauseCount = result.blockageReport.rootCauseHypotheses?.length ?? 0;
      lines.push(`  根因假设数: ${rootCauseCount}`);
      if (result.blockageReport.requiredDecisions?.length) {
        lines.push(`  待决策数: ${result.blockageReport.requiredDecisions.length}`);
      }
    }

    return lines.join("\n");
  }

  // ============================================================================
  // EAG-P3 批次 10：/eag-resume 命令处理（§4.18.3）
  // ============================================================================

  /**
   * 处理 `/eag-resume` 命令，从断点恢复长程自动化（§4.18.3）
   *
   * EAG-P3 批次 11 S3 改造：request 参数由 EagCommandParser.parse() 预提取后注入（D-S3-7），
   * 不再在本方法内部调用 extractEagResumeRequest。payload 为 null 时通知用户配置缺失。
   *
   * 算法（对齐 §4.18.3 + 复用 handleEagRunCommand 既有模式）：
   * 1. 校验外挂依赖：runStateStore 必须注入
   *    未注入 → 通知用户配置缺失，更新 session 状态为 failed（向后兼容）
   * 2. 校验 EagResumeRequest（由 EagCommandParser 预提取的 payload）
   *    未提供 payload → 通知用户配置缺失
   * 3. 构造 EagResumeHandler（内部 new MultiLoopPlanner / MilestoneTagger / BlockageAnalyzer）
   * 4. 调用 handler.handle(request) 从断点恢复执行
   *    异常路径：catch 后通知用户错误，更新 session 状态为 failed
   * 5. 渲染结果：复用 renderEagRunResult（产出类型与 EagRunResult 一致）
   * 6. 更新 session 状态为 completed/failed
   *
   * @param sessionId 会话 ID
   * @param userPrompt 用户输入（仅用于写入用户消息历史，不参与编排）
   * @param request 预装配的 EagResumeRequest（由 EagCommandParser.parse() 提取，可空）
   * @param controller 中断控制器（用于响应 abort 信号）
   */
  private async handleEagResumeCommand(
    sessionId: string,
    userPrompt: UserPromptContent,
    request: EagResumeRequest | null,
    controller?: AbortController
  ): Promise<void> {
    const signal = controller?.signal;
    this.throwIfAborted(signal);

    const now = new Date().toISOString();
    const userMessage = this.buildUserMessage(sessionId, userPrompt);
    this.appendSessionMessage(sessionId, userMessage);

    this.updateSessionEntry(sessionId, (entry) => ({
      ...entry,
      status: "processing",
      failReason: null,
      updateTime: now,
    }));

    // 步骤 1：校验外挂依赖
    if (!this.runStateStore) {
      const errMsg = "RunStateStore 未注入：请在 SessionManagerOptions.runStateStore 配置后重启（参考 §4.18.3）";
      this.updateSessionEntry(sessionId, (entry) => ({
        ...entry,
        status: "failed",
        failReason: errMsg,
        updateTime: new Date().toISOString(),
      }));
      this.onAssistantMessage(this.buildAssistantMessage(sessionId, `[EAG RESUME] ${errMsg}`, null), false);
      return;
    }

    // 步骤 2：校验 EagResumeRequest（EAG-P3 批次 11 S3：payload 由 EagCommandParser 预提取）
    // EagCommandParser.parse() 已从 userPrompt.messageParams.eagResumeRequest 提取并完成字段校验
    // payload 为 null 时通知用户配置缺失（保持既有错误提示路径不丢失）
    if (!request) {
      const errMsg =
        "EagResumeRequest 未提供：请通过 userPrompt.messageParams.eagResumeRequest 传入预装配的恢复请求（参考 §4.18.3）";
      this.updateSessionEntry(sessionId, (entry) => ({
        ...entry,
        status: "failed",
        failReason: errMsg,
        updateTime: new Date().toISOString(),
      }));
      this.onAssistantMessage(this.buildAssistantMessage(sessionId, `[EAG RESUME] ${errMsg}`, null), false);
      return;
    }

    // 步骤 3：构造 EagResumeHandler
    let handler: EagResumeHandler;
    try {
      handler = new EagResumeHandler({
        multiLoopPlanner: new MultiLoopPlanner(),
        runStateStore: this.runStateStore,
        milestoneTagger: new MilestoneTagger(this.runStateStore),
        blockageAnalyzer: new BlockageAnalyzer(this.runStateStore),
      });
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      this.updateSessionEntry(sessionId, (entry) => ({
        ...entry,
        status: "failed",
        failReason: `EagResumeHandler 构造失败：${errMsg}`,
        updateTime: new Date().toISOString(),
      }));
      this.onAssistantMessage(
        this.buildAssistantMessage(sessionId, `[EAG RESUME] 处理器构造失败：${errMsg}`, null),
        false
      );
      return;
    }

    // 步骤 4：调用 handler.handle(request) 从断点恢复
    let result: EagRunResult;
    try {
      result = await handler.handle(request);
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      this.updateSessionEntry(sessionId, (entry) => ({
        ...entry,
        status: "failed",
        failReason: `EAG Resume 编排异常：${errMsg}`,
        updateTime: new Date().toISOString(),
      }));
      this.onAssistantMessage(
        this.buildAssistantMessage(
          sessionId,
          `[EAG RESUME] 编排异常：${errMsg}\n请检查 runId 是否存在、git HEAD 是否一致、LoopExecutor 配置是否正确。`,
          null
        ),
        false
      );
      return;
    }

    // 步骤 5：渲染结果摘要（复用 renderEagRunResult）
    const summary = this.renderEagRunResult(result);
    this.onAssistantMessage(this.buildAssistantMessage(sessionId, summary, null), false);

    // 步骤 6：更新 session 状态
    const isSuccess = result.finalStatus === "completed";
    this.updateSessionEntry(sessionId, (entry) => ({
      ...entry,
      status: isSuccess ? "completed" : "failed",
      failReason: isSuccess ? null : `EAG Resume 终止：${result.finalStatus}`,
      updateTime: new Date().toISOString(),
    }));
  }

  // ============================================================================
  // EAG-P3 批次 10：/eag-status 命令处理（§4.18.3）
  // ============================================================================

  /**
   * 处理 `/eag-status` 命令，输出长程进度报告（§4.18.3）
   *
   * EAG-P3 批次 11 S3 改造：request 参数由 EagCommandParser.parse() 预提取后注入（D-S3-7），
   * 不再在本方法内部调用 extractEagStatusRequest。payload 为 null 时通知用户配置缺失。
   *
   * 算法（对齐 §4.18.3）：
   * 1. 校验外挂依赖：runStateStore 必须注入
   *    未注入 → 通知用户配置缺失，更新 session 状态为 failed（向后兼容）
   * 2. 校验 EagStatusRequest（由 EagCommandParser 预提取的 payload）
   *    未提供 payload → 通知用户配置缺失
   * 3. 构造 EagStatusHandler（仅依赖 runStateStore）
   * 4. 调用 handler.handle(request) 生成 Markdown 报告
   *    异常路径：catch 后通知用户错误，更新 session 状态为 failed
   * 5. 渲染结果：通过 onAssistantMessage 发送报告
   * 6. 更新 session 状态为 completed（status 是查询命令，不会修改 run 状态）
   *
   * @param sessionId 会话 ID
   * @param userPrompt 用户输入（仅用于写入用户消息历史，不参与编排）
   * @param request 预装配的 EagStatusRequest（由 EagCommandParser.parse() 提取，可空）
   * @param controller 中断控制器（用于响应 abort 信号）
   */
  private async handleEagStatusCommand(
    sessionId: string,
    userPrompt: UserPromptContent,
    request: EagStatusRequest | null,
    controller?: AbortController
  ): Promise<void> {
    const signal = controller?.signal;
    this.throwIfAborted(signal);

    const now = new Date().toISOString();
    const userMessage = this.buildUserMessage(sessionId, userPrompt);
    this.appendSessionMessage(sessionId, userMessage);

    this.updateSessionEntry(sessionId, (entry) => ({
      ...entry,
      status: "processing",
      failReason: null,
      updateTime: now,
    }));

    // 步骤 1：校验外挂依赖
    if (!this.runStateStore) {
      const errMsg = "RunStateStore 未注入：请在 SessionManagerOptions.runStateStore 配置后重启（参考 §4.18.3）";
      this.updateSessionEntry(sessionId, (entry) => ({
        ...entry,
        status: "failed",
        failReason: errMsg,
        updateTime: new Date().toISOString(),
      }));
      this.onAssistantMessage(this.buildAssistantMessage(sessionId, `[EAG STATUS] ${errMsg}`, null), false);
      return;
    }

    // 步骤 2：校验 EagStatusRequest（EAG-P3 批次 11 S3：payload 由 EagCommandParser 预提取）
    // EagCommandParser.parse() 已从 userPrompt.messageParams.eagStatusRequest 提取并完成字段校验
    // payload 为 null 时通知用户配置缺失（保持既有错误提示路径不丢失）
    if (!request) {
      const errMsg =
        "EagStatusRequest 未提供：请通过 userPrompt.messageParams.eagStatusRequest 传入预装配的查询请求（参考 §4.18.3）";
      this.updateSessionEntry(sessionId, (entry) => ({
        ...entry,
        status: "failed",
        failReason: errMsg,
        updateTime: new Date().toISOString(),
      }));
      this.onAssistantMessage(this.buildAssistantMessage(sessionId, `[EAG STATUS] ${errMsg}`, null), false);
      return;
    }

    // 步骤 3 & 4：构造 EagStatusHandler 并执行查询
    let result: EagStatusResult;
    try {
      const handler = new EagStatusHandler({ runStateStore: this.runStateStore });
      result = await handler.handle(request);
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      this.updateSessionEntry(sessionId, (entry) => ({
        ...entry,
        status: "failed",
        failReason: `EAG Status 查询异常：${errMsg}`,
        updateTime: new Date().toISOString(),
      }));
      this.onAssistantMessage(
        this.buildAssistantMessage(
          sessionId,
          `[EAG STATUS] 查询异常：${errMsg}\n请检查 runId 是否存在、projectRoot 是否正确。`,
          null
        ),
        false
      );
      return;
    }

    // 步骤 5：渲染结果摘要
    const summary = this.renderEagStatusResult(result);
    this.onAssistantMessage(this.buildAssistantMessage(sessionId, summary, null), false);

    // 步骤 6：更新 session 状态为 completed（查询命令不修改 run 状态）
    this.updateSessionEntry(sessionId, (entry) => ({
      ...entry,
      status: "completed",
      failReason: null,
      updateTime: new Date().toISOString(),
    }));
  }

  /**
   * 渲染 EagStatusResult 为可读的摘要文本（§4.18.3）
   *
   * 渲染内容：
   * - 标题
   * - 单 run 详情（runId 提供时）：状态 + 当前 Loop + 里程碑数 + 阻塞数
   * - 最近 run 列表（runId 未提供时）：runId + status + 进度
   * - 完整 Markdown 报告
   *
   * @param result EAG Status 查询产出
   * @returns 可读的摘要文本
   */
  private renderEagStatusResult(result: Readonly<EagStatusResult>): string {
    const lines: string[] = [];
    lines.push("[EAG STATUS] 长程进度报告");

    // 单 run 详情
    if (result.runState) {
      const rs = result.runState;
      lines.push(`runId: ${rs.runId}`);
      lines.push(`状态: ${rs.status}`);
      lines.push(`当前 Loop: ${rs.currentLoop}`);
      lines.push(`里程碑数: ${rs.milestones?.length ?? 0}`);
      lines.push(`人工介入记录数: ${rs.humanInterventions?.length ?? 0}`);
    }

    // 最近 run 列表
    if (result.recentRuns && result.recentRuns.length > 0) {
      lines.push("");
      lines.push(`最近 ${result.recentRuns.length} 次 run:`);
      for (const summary of result.recentRuns) {
        lines.push(`  - ${summary.runId}: ${summary.status}`);
      }
    }

    // 完整 Markdown 报告（截断到 2000 字符避免输出过长）
    if (result.report) {
      lines.push("");
      lines.push("完整报告:");
      const reportLimit = 2000;
      if (result.report.length > reportLimit) {
        lines.push(result.report.slice(0, reportLimit));
        lines.push(`...（其余 ${result.report.length - reportLimit} 字符已省略）`);
      } else {
        lines.push(result.report);
      }
    }

    return lines.join("\n");
  }

  // ============================================================================
  // EAG-P4 批次 13：/eag-deploy 命令处理（§3.4 / §5.2）
  // ============================================================================

  /**
   * 处理 `/eag-deploy` 命令，触发 DEPLOY Loop 编排（§3.4 / §5.2）
   *
   * EAG-P4 批次 13 Phase 7 §5.2：DevOps 第 6 角色编排器入口。
   *
   * 算法（对齐设计文档 §3.4 + 复用既有 handleEagXxxCommand 模式）：
   * 1. 校验外挂依赖：devopsOrchestrator 必须注入
   *    未注入 → 通知用户配置缺失，更新 session 状态为 failed（向后兼容）
   * 2. 校验 DeployRequest（由 EagCommandParser 预提取的 payload）
   *    未提供 payload → 通知用户配置缺失
   * 3. 装配 DevOpsContext：
   *    - 从 DeployRequest 映射 iacGenerationContext（含 projectName / environment / replicas / image / port）
   *    - 从 DeployRequest 映射 deployContext（runId 用 crypto.randomUUID 生成）
   *    - GateContext 字段使用默认值（specStatus / planStatus = "approved"，userApproved = true 等）
   *      原因：DEPLOY Loop 假设上游 CODING/TESTING Loop 已完成，方案与计划均已批准
   *    - smokeTestCases 使用最小 healthz 用例（GET /healthz → 200）
   *    - monitoringReady / rollbackPlanExists 默认 true（批次 14 实现完整检查）
   * 4. 调用 devopsOrchestrator.run(context) 执行 5 步编排
   *    异常路径：catch 后通知用户错误，更新 session 状态为 failed
   * 5. 渲染结果：通过 onAssistantMessage 发送结果摘要（含 success / duration / IaC 模板数 / 部署资源数 / 健康检查 / 烟雾测试 / G-8 门禁）
   * 6. 更新 session 状态为 completed/failed（依据 result.success）
   *
   * 设计决策（与设计文档 §5.2 N-M-1 修复对齐）：
   * - 不在 handleEagDeployCommand 内部 new DevOpsOrchestrator（避免每次命令重复构造）
   * - DevOpsOrchestrator 的全部依赖（iacGenerators / gateG8Checker / deployStrategy /
   *   deployStage / eventEmitter）由调用方在 SessionManagerOptions.devopsOrchestrator
   *   中完整装配后注入
   * - session.ts 仅负责装配 DevOpsContext + 调用 run() + 渲染 DevOpsResult
   *
   * 不可变优先（§5.12.4 G-A6d）：
   * - 装配的 DevOpsContext 通过 Object.freeze 冻结
   * - iacGenerationContext / deployContext / taskCard 等嵌套对象均冻结
   * - result 由 DevOpsOrchestrator 内部冻结
   *
   * @param sessionId 会话 ID
   * @param userPrompt 用户输入（仅用于写入用户消息历史，不参与编排）
   * @param request 预装配的 DeployRequest（由 EagCommandParser.parse() 提取，可空）
   * @param controller 中断控制器（用于响应 abort 信号）
   */
  private async handleEagDeployCommand(
    sessionId: string,
    userPrompt: UserPromptContent,
    request: DeployRequest | null,
    controller?: AbortController
  ): Promise<void> {
    const signal = controller?.signal;
    this.throwIfAborted(signal);

    const now = new Date().toISOString();
    // 记录用户输入到消息历史（保持会话上下文完整）
    const userMessage = this.buildUserMessage(sessionId, userPrompt);
    this.appendSessionMessage(sessionId, userMessage);

    // 更新 session 状态为 processing
    this.updateSessionEntry(sessionId, (entry) => ({
      ...entry,
      status: "processing",
      failReason: null,
      updateTime: now,
    }));

    // 步骤 1：校验外挂依赖
    if (!this.devopsOrchestrator) {
      const errMsg =
        "DevOps 编排器未注入：请在 SessionManagerOptions.devopsOrchestrator 配置后重启（参考 §3.4 / §5.2）";
      this.updateSessionEntry(sessionId, (entry) => ({
        ...entry,
        status: "failed",
        failReason: errMsg,
        updateTime: new Date().toISOString(),
      }));
      this.onAssistantMessage(this.buildAssistantMessage(sessionId, `[EAG DEPLOY Loop] ${errMsg}`, null), false);
      return;
    }

    // 步骤 2：校验 DeployRequest（EAG-P3 批次 11 S3：payload 由 EagCommandParser 预提取）
    // EagCommandParser.parse() 已从 userPrompt.messageParams.deployRequest 提取并完成字段校验
    // （projectName / environment / image / port / replicas / iacType / strategy / dryRun? 全部已校验）
    // payload 为 null 时通知用户配置缺失（保持既有错误提示路径不丢失）
    if (!request) {
      const errMsg =
        "DeployRequest 未提供：请通过 userPrompt.messageParams.deployRequest 传入预装配的部署请求（参考 §5.1 / §5.2）";
      this.updateSessionEntry(sessionId, (entry) => ({
        ...entry,
        status: "failed",
        failReason: errMsg,
        updateTime: new Date().toISOString(),
      }));
      this.onAssistantMessage(this.buildAssistantMessage(sessionId, `[EAG DEPLOY Loop] ${errMsg}`, null), false);
      return;
    }

    // 步骤 3：装配 DevOpsContext
    // 设计说明：DEPLOY Loop 假设上游 CODING/TESTING Loop 已完成，GateContext 字段使用默认值
    // - projectId: 取 request.projectName（K8s Namespace / Helm Release 命名基础）
    // - loopType: 固定 "deploy"（DevOpsContext 类型约束）
    // - specStatus / planStatus: "approved"（DEPLOY Loop 入口前提）
    // - reviewRecords: []（评审记录已在 CODING Loop G-2 门禁时收集，此处无需重复）
    // - userApproved: true（DEPLOY Loop 假设用户已批准部署）
    // - taskCard: 最小化占位（DEPLOY Loop 不依赖 taskCard，但 GateContext 接口要求提供）
    // - actualChanges: []（实际变更已在 CODING Loop G-3 门禁时校验，此处无需重复）
    // - iacGenerationContext: 从 DeployRequest 映射，使用默认资源配置（批次 14 扩展为可配置）
    // - deployContext: 从 DeployRequest 映射，runId 用 crypto.randomUUID 生成
    //   iacTemplates 初始为空数组（由 DevOpsOrchestrator.run() 内部 IaC 生成器产出后传给 DeployStage）
    // - smokeTestCases: 最小 healthz 用例（GET /healthz → 200）
    //   批次 14 扩展为从 spec.md 验收标准自动派生
    // - monitoringReady / rollbackPlanExists: 默认 true（批次 14 实现完整检查）
    const runId = crypto.randomUUID();
    const iacGenerationContext = Object.freeze({
      projectName: request.projectName,
      environment: request.environment,
      replicas: request.replicas,
      image: request.image,
      port: request.port,
      // 默认资源配置：requests 100m / 128Mi，limits 500m / 512Mi
      // 批次 14 扩展为从项目配置文件读取（如 eag.yaml）
      resources: Object.freeze({
        requests: Object.freeze({ cpu: "100m", memory: "128Mi" }),
        limits: Object.freeze({ cpu: "500m", memory: "512Mi" }),
      }),
      envVars: Object.freeze([]),
    });
    const deployContext = Object.freeze({
      runId,
      projectName: request.projectName,
      environment: request.environment,
      iacTemplates: Object.freeze([]),
      strategyType: request.strategy,
      timeoutMs: 300000, // 默认 5 分钟超时
    });
    const taskCard = Object.freeze({
      id: "T-DEPLOY",
      title: `部署 ${request.projectName} 到 ${request.environment} 环境`,
      requirementId: "F-DEPLOY",
      dependencies: Object.freeze([]),
      acceptanceCriteria: Object.freeze([
        `IaC 模板生成与校验通过（${request.iacType}）`,
        `部署成功（策略：${request.strategy}）`,
        "健康检查通过",
        "烟雾测试通过",
        "G-8 门禁通过",
      ]),
      status: "in-progress" as const,
      declaredSymbols: Object.freeze([]),
    });
    const smokeTestCases = Object.freeze([
      Object.freeze({
        name: "healthz endpoint returns 200",
        method: "GET" as const,
        path: "/healthz",
        expectedStatusCode: 200,
      }),
    ]);
    const devOpsContext: DevOpsContext = Object.freeze({
      projectId: request.projectName,
      loopType: "deploy",
      specStatus: "approved",
      planStatus: "approved",
      reviewRecords: Object.freeze([]),
      userApproved: true,
      taskCard,
      actualChanges: Object.freeze([]),
      iacGenerationContext,
      deployContext,
      smokeTestCases,
      monitoringReady: true,
      rollbackPlanExists: true,
    }) as DevOpsContext;

    // dryRun 模式：仅生成 IaC 模板，不实际部署
    // 当前批次（13）暂不支持 dryRun 短路，DevOpsOrchestrator.run() 始终执行完整 5 步编排
    // 批次 14 扩展：dryRun=true 时仅执行 Step 1~3（生成 + 校验 IaC），跳过 Step 4~5（部署 + 门禁）
    // 此处仅记录日志，不影响编排流程
    if (request.dryRun) {
      this.onAssistantMessage(
        this.buildAssistantMessage(
          sessionId,
          `[EAG DEPLOY Loop] dryRun 模式已启用（批次 13 暂不支持短路，将执行完整编排流程）`,
          null
        ),
        false
      );
    }

    // 步骤 4：调用 devopsOrchestrator.run(context) 执行 5 步编排
    // P1-2 修复（架构师审查）：编排前再次检查 abort 信号
    // 避免用户在装配 DevOpsContext 期间 abort 后仍继续执行编排
    this.throwIfAborted(signal);
    let result: DevOpsResult;
    try {
      result = await this.devopsOrchestrator.run(devOpsContext);
    } catch (e) {
      // P1-2 修复（架构师审查）：catch 块区分 abort 异常与其他异常
      // - abort 异常：session 状态标记为 cancelled（用户主动中断）
      // - 其他异常：session 状态标记为 failed（编排失败）
      const isAborted = this.isAbortLikeError(e) || signal?.aborted === true;
      const errMsg = e instanceof Error ? e.message : String(e);
      this.updateSessionEntry(sessionId, (entry) => ({
        ...entry,
        status: "failed",
        failReason: isAborted ? `DEPLOY Loop 被用户中断：${errMsg}` : `DEPLOY Loop 编排异常：${errMsg}`,
        updateTime: new Date().toISOString(),
      }));
      this.onAssistantMessage(
        this.buildAssistantMessage(
          sessionId,
          isAborted
            ? `[EAG DEPLOY Loop] 编排被用户中断：${errMsg}`
            : `[EAG DEPLOY Loop] 编排异常：${errMsg}\n请检查依赖组件（IaCGenerator / GateG8Checker / DeployStrategy / DeployStage / PreDeployChecker / PostDeployChecker / SmokeTestRunner）配置是否正确。`,
          null
        ),
        false
      );
      return;
    }

    // P1-2 修复（架构师审查）：编排完成后再次检查 abort 信号
    // 避免编排完成后用户已 abort 还要继续渲染结果与更新 session 状态
    if (signal?.aborted) {
      this.updateSessionEntry(sessionId, (entry) => ({
        ...entry,
        status: "failed",
        failReason: "DEPLOY Loop 被用户中断（编排完成后）",
        updateTime: new Date().toISOString(),
      }));
      this.onAssistantMessage(
        this.buildAssistantMessage(
          sessionId,
          `[EAG DEPLOY Loop] 编排已完成但被用户中断，结果未渲染。runId: ${result.runId}`,
          null
        ),
        false
      );
      return;
    }

    // 步骤 5：渲染结果摘要
    // P1-1 修复（架构师审查）：渲染失败时降级为简单文本摘要，确保步骤 6 的 session 状态更新一定执行
    // 防御 DevOpsOrchestrator 返回的 result 字段异常（如 gateResult 为 undefined / iacTemplates 元素缺少 hash）
    let summary: string;
    try {
      summary = this.renderDevOpsResult(result);
    } catch (renderErr) {
      const renderErrMsg = renderErr instanceof Error ? renderErr.message : String(renderErr);
      summary = `[EAG DEPLOY Loop] 编排完成（结果渲染失败：${renderErrMsg}）\n最终状态: ${result.success ? "成功" : "失败"}\nrunId: ${result.runId}`;
    }
    this.onAssistantMessage(this.buildAssistantMessage(sessionId, summary, null), false);

    // 步骤 6：更新 session 状态（依据 result.success）
    this.updateSessionEntry(sessionId, (entry) => ({
      ...entry,
      status: result.success ? "completed" : "failed",
      failReason: result.success
        ? null
        : `DEPLOY Loop 终止：${result.errors.length > 0 ? result.errors.join("；") : result.gateResult.reason}`,
      updateTime: new Date().toISOString(),
    }));
  }

  /**
   * 渲染 DevOpsResult 为可读的摘要文本（§3.4 / §5.2）
   *
   * 渲染内容：
   * - 编排结果（success / failed）
   * - runId + 总耗时
   * - IaC 模板清单（前 10 个，含 type / filePath / hash 前 8 位）
   * - 部署资源清单（前 10 个，含 kind / name / namespace / status）
   * - 健康检查结果（healthy + 端点数 + 失败数）
   * - 烟雾测试结果（passed + totalTests + passedTests + failedTests）
   * - G-8 门禁结果（passed + reason）
   * - 错误信息列表（前 10 条）
   *
   * @param result DevOps 编排产出
   * @returns 可读的摘要文本
   */
  private renderDevOpsResult(result: Readonly<DevOpsResult>): string {
    const lines: string[] = [];
    lines.push("[EAG DEPLOY Loop] 编排完成");
    lines.push(`最终状态: ${result.success ? "成功" : "失败"}`);
    lines.push(`runId: ${result.runId}`);
    // 耗时换算：毫秒 → 秒（保留 1 位小数）
    const durationSec = (result.duration / 1000).toFixed(1);
    lines.push(`总耗时: ${durationSec}s（${result.startedAt} → ${result.finishedAt}）`);

    // IaC 模板清单（前 10 个，避免输出过长）
    if (result.iacTemplates.length > 0) {
      lines.push("");
      lines.push(`IaC 模板 (${result.iacTemplates.length} 个):`);
      const iacLimit = Math.min(result.iacTemplates.length, 10);
      for (let i = 0; i < iacLimit; i++) {
        const t = result.iacTemplates[i];
        // hash 前 8 位用作短摘要（SHA256 完整 64 位在审计日志中查看）
        const hashPrefix = t.hash.slice(0, 8);
        lines.push(`  - [${t.type}] ${t.filePath} (hash: ${hashPrefix})`);
      }
      if (result.iacTemplates.length > iacLimit) {
        lines.push(`  ...（其余 ${result.iacTemplates.length - iacLimit} 个模板已省略）`);
      }
    }

    // 部署资源清单（前 10 个）
    if (result.deployResult && result.deployResult.resources.length > 0) {
      lines.push("");
      const resources = result.deployResult.resources;
      lines.push(`部署资源 (${resources.length} 个):`);
      const resLimit = Math.min(resources.length, 10);
      for (let i = 0; i < resLimit; i++) {
        const r = resources[i];
        lines.push(`  - ${r.kind}/${r.name} (namespace: ${r.namespace}, status: ${r.status})`);
      }
      if (resources.length > resLimit) {
        lines.push(`  ...（其余 ${resources.length - resLimit} 个资源已省略）`);
      }
    }

    // 健康检查结果
    if (result.healthCheckResult) {
      lines.push("");
      const hcr = result.healthCheckResult;
      const endpointsCount = hcr.endpoints.length;
      const failuresCount = hcr.failures.length;
      lines.push(`健康检查: ${hcr.healthy ? "通过" : "未通过"}（端点数: ${endpointsCount}, 失败数: ${failuresCount}）`);
    }

    // 烟雾测试结果
    if (result.smokeTestResult) {
      const str = result.smokeTestResult;
      lines.push(
        `烟雾测试: ${str.passed ? "通过" : "未通过"}（总计: ${str.totalTests}, 通过: ${str.passedTests}, 失败: ${str.failedTests}）`
      );
    }

    // G-8 门禁结果
    lines.push("");
    lines.push(`G-8 门禁: ${result.gateResult.passed ? "通过" : "未通过"}（severity: ${result.gateResult.severity}）`);
    lines.push(`门禁理由: ${result.gateResult.reason}`);

    // 错误信息列表（前 10 条）
    if (result.errors.length > 0) {
      lines.push("");
      lines.push(`错误信息 (${result.errors.length} 条):`);
      const errLimit = Math.min(result.errors.length, 10);
      for (let i = 0; i < errLimit; i++) {
        lines.push(`  - ${result.errors[i]}`);
      }
      if (result.errors.length > errLimit) {
        lines.push(`  ...（其余 ${result.errors.length - errLimit} 条错误已省略）`);
      }
    }

    return lines.join("\n");
  }

  // ============================================================================
  // EAG-P5 Phase 5.4 TASK-P5-5.4-002：/eag-autonomous 命令处理器
  // ============================================================================

  /**
   * 处理 /eag-autonomous 命令（EAG-P5 Phase 5.4 TASK-P5-5.4-002）
   *
   * 职责（对齐架构师审查 §4.1 + §5 CLI 命令规范 + handleEagDeployCommand 同构模式）：
   * 1. 记录用户输入到消息历史（保持会话上下文完整）
   * 2. 更新 session 状态为 processing
   * 3. 校验外挂依赖 autonomousOrchestrator（未注入时 fail-closed 通知用户）
   * 4. 校验 EagAutonomousRequest payload（null 时从命令字符串重新解析以获取错误详情）
   * 5. 创建 EagAutonomousCommandHandler 实例并调用 execute(request, projectRoot)
   * 6. 通过 onAssistantMessage 渲染 markdownReport（成功 / 失败两条路径）
   * 7. 更新 session 状态为 completed / failed（依据 result.success）
   *
   * 设计决策（对齐 §5.2 N-M-1 修复 + Karpathy Simplicity First）：
   * - 不在方法内部 new AutonomousOrchestrator（避免每次命令重复构造）
   * - AutonomousOrchestrator 的全部依赖（loopExecutor / runStateStore / notesMemory /
   *   guardChain / smartConfirmation）由调用方在 SessionManagerOptions.autonomousOrchestrator
   *   中完整装配后注入
   * - EagAutonomousCommandHandler 负责具体装配 AutonomousRunRequest + 调用 run() + 渲染结果
   * - session.ts 仅负责校验注入 + 装配请求 + 调用 handler.execute() + 渲染结果
   *
   * 错误处理策略（对齐 handleEagDeployCommand 模式）：
   * - 依赖未注入：fail-closed，session 标记 failed
   * - payload null：尝试重新解析命令字符串获取错误详情，fail-closed
   * - handler.execute() 抛异常：捕获异常，session 标记 failed
   * - abort 信号：在装配前 / handler 调用前 / handler 调用后三个检查点响应中断
   *
   * 不可变优先（§5.12.4 G-A6d）：
   * - EagAutonomousRequest 由 EagCommandParser.parse() 冻结后传入
   * - EagAutonomousCommandResult 由 handler.execute() 内部冻结后返回
   * - 不修改任何外部状态，所有副作用通过 onAssistantMessage / updateSessionEntry 路由
   *
   * @param sessionId 会话 ID
   * @param userPrompt 用户输入（仅用于写入用户消息历史，不参与编排）
   * @param request 预装配的 EagAutonomousRequest（由 EagCommandParser.parse() 提取，可空）
   * @param controller 中断控制器（用于响应 abort 信号）
   */
  private async handleEagAutonomousCommand(
    sessionId: string,
    userPrompt: UserPromptContent,
    request: EagAutonomousRequest | null,
    controller?: AbortController
  ): Promise<void> {
    const signal = controller?.signal;
    this.throwIfAborted(signal);

    const now = new Date().toISOString();
    // 步骤 1：记录用户输入到消息历史（保持会话上下文完整）
    const userMessage = this.buildUserMessage(sessionId, userPrompt);
    this.appendSessionMessage(sessionId, userMessage);

    // 步骤 2：更新 session 状态为 processing
    this.updateSessionEntry(sessionId, (entry) => ({
      ...entry,
      status: "processing",
      failReason: null,
      updateTime: now,
    }));

    // 步骤 3：校验外挂依赖 autonomousOrchestrator（未注入时 fail-closed）
    if (!this.autonomousOrchestrator) {
      const errMsg =
        "AutonomousOrchestrator 未注入：请在 SessionManagerOptions.autonomousOrchestrator 配置后重启（参考 §4.1 / §5 CLI 命令规范）";
      this.updateSessionEntry(sessionId, (entry) => ({
        ...entry,
        status: "failed",
        failReason: errMsg,
        updateTime: new Date().toISOString(),
      }));
      this.onAssistantMessage(this.buildAssistantMessage(sessionId, `[EAG Autonomous Loop] ${errMsg}`, null), false);
      return;
    }

    // 步骤 4：校验 EagAutonomousRequest payload
    // EagCommandParser.parse() 已通过两种路径提取 payload：
    //   路径 A：从 userPrompt.messageParams.autonomousRunRequest 提取（UI 表单模式）
    //   路径 B：从命令字符串内联参数解析（CLI 模式，extractEagAutonomousRequestFromPrompt）
    // payload 为 null 时表示两种路径均失败：
    //   - 命令字符串前缀匹配成功（/eag-autonomous）
    //   - 但参数解析抛异常（如缺少 --goal / --max-iterations 取值非法）
    // 此时重新调用 extractEagAutonomousRequestFromPrompt(userPrompt.text) 以获取具体错误信息
    let validatedRequest: EagAutonomousRequest;
    if (request) {
      validatedRequest = request;
    } else {
      // payload null：尝试从命令字符串重新解析以获取错误详情
      // 注：进入此分支前置条件为 EagCommandParser.parse() 返回 kind="eag-autonomous"，
      // 即 userPrompt.text 已通过 typeof string 校验（见 eag-command-parser.ts L218）。
      // 此处使用 String() 强制转换以消除 TS 的 string|undefined 不确定提示。
      let parseErrorMsg: string;
      try {
        // 重新解析以触发异常并获取错误详情
        extractEagAutonomousRequestFromPrompt(String(userPrompt.text ?? ""));
        // 理论不可达：若 parser 已返回 null，重新解析应该抛异常
        // 此处兜底：若未抛异常，使用通用错误消息
        parseErrorMsg =
          "EagAutonomousRequest 解析返回 null 但未抛异常（理论不可达，请检查 EagCommandParser.extractEagAutonomousRequest 实现）";
      } catch (parseErr) {
        parseErrorMsg = parseErr instanceof Error ? parseErr.message : String(parseErr);
      }
      const errMsg = `EagAutonomousRequest 解析失败：${parseErrorMsg}（期望格式：/eag-autonomous --goal "<目标>" --max-iterations 10 --confirmation smart）`;
      this.updateSessionEntry(sessionId, (entry) => ({
        ...entry,
        status: "failed",
        failReason: errMsg,
        updateTime: new Date().toISOString(),
      }));
      this.onAssistantMessage(this.buildAssistantMessage(sessionId, `[EAG Autonomous Loop] ${errMsg}`, null), false);
      return;
    }

    // 步骤 5：创建 EagAutonomousCommandHandler 实例并调用 execute()
    // 设计说明：handler 内部完成 AutonomousRunRequest 装配 + orchestrator.run() 调用 +
    // Markdown 报告渲染 + 异常兜底，session.ts 仅需调用 execute() 即可
    // 装配前再次检查 abort 信号（对齐 handleEagDeployCommand 的 P1-2 修复）
    this.throwIfAborted(signal);
    const handler = new EagAutonomousCommandHandler(this.autonomousOrchestrator);
    let result: Readonly<EagAutonomousCommandResult>;
    try {
      result = await handler.execute(validatedRequest, this.projectRoot);
    } catch (e) {
      // 异常兜底：handler.execute() 内部已 try/catch orchestrator.run()，
      // 此处捕获的是 handler 自身的异常（如 validateRequest 抛错、formatSuccessReport 异常）
      const isAborted = this.isAbortLikeError(e) || signal?.aborted === true;
      const errMsg = e instanceof Error ? e.message : String(e);
      this.updateSessionEntry(sessionId, (entry) => ({
        ...entry,
        status: "failed",
        failReason: isAborted ? `Autonomous Loop 被用户中断：${errMsg}` : `Autonomous Loop 执行异常：${errMsg}`,
        updateTime: new Date().toISOString(),
      }));
      this.onAssistantMessage(
        this.buildAssistantMessage(
          sessionId,
          isAborted
            ? `[EAG Autonomous Loop] 编排被用户中断：${errMsg}`
            : `[EAG Autonomous Loop] 编排异常：${errMsg}\n请检查 AutonomousOrchestrator 的 5 个核心依赖（loopExecutor / runStateStore / notesMemory / guardChain / smartConfirmation）配置是否正确。`,
          null
        ),
        false
      );
      return;
    }

    // handler.execute() 完成后再次检查 abort 信号
    // 避免 handler 完成后用户已 abort 还要继续渲染结果
    if (signal?.aborted) {
      this.updateSessionEntry(sessionId, (entry) => ({
        ...entry,
        status: "failed",
        failReason: "Autonomous Loop 被用户中断（编排完成后）",
        updateTime: new Date().toISOString(),
      }));
      this.onAssistantMessage(
        this.buildAssistantMessage(
          sessionId,
          `[EAG Autonomous Loop] 编排已完成但被用户中断，结果未渲染。success: ${result.success}`,
          null
        ),
        false
      );
      return;
    }

    // 步骤 6：渲染结果摘要
    // result.markdownReport 已由 handler.formatSuccessReport / formatErrorReport 装配，
    // session.ts 直接通过 onAssistantMessage 推送给用户
    this.onAssistantMessage(this.buildAssistantMessage(sessionId, result.markdownReport, null), false);

    // 步骤 7：更新 session 状态（依据 result.success）
    // - success=true：session 标记 completed（包括 finalStatus=completed / stop_when / aborted，
    //   因为 handler.execute() 已捕获 orchestrator 异常并返回 success=false）
    // - success=false：session 标记 failed，failReason 取 errorMessage
    this.updateSessionEntry(sessionId, (entry) => ({
      ...entry,
      status: result.success ? "completed" : "failed",
      failReason: result.success ? null : `Autonomous Loop 终止：${result.errorMessage}`,
      updateTime: new Date().toISOString(),
    }));
  }

  // ============================================================================
  // EAG-P3 批次 10：候选规则检测 Hook（§4.18.4 detectRuleCandidateHook）
  // ============================================================================

  /**
   * 候选规则检测 Hook（§4.18.4 detectRuleCandidateHook，落地 L-4）
   *
   * 主对话循环每次用户输入后调用：
   * 1. 调用 ruleLearner.detectCorrection(userMessage) 检测纠正模式
   *    （"不要..." / "严禁..." / "必须..." / "以后都..." / "禁止..."）
   * 2. 命中纠正模式 → extractCandidate 提取规则候选（推断 category / severity）
   * 3. accumulateCandidate 累积候选（同类纠正 occurrenceCount+1，§5.5.4 防误学红线）
   * 4. shouldPushConfirmation 判定是否推送确认请求（≥2 次才推送）
   * 5. 推送确认请求 → 通过 onAssistantMessage 提示用户回复 `/rule-confirm <id>` 确认
   *
   * 未注入 ruleLearner 时直接返回（向后兼容，零开销）。
   * 异常路径：内部 try/catch，不影响主对话循环，仅通过 onAssistantMessage 通知异常。
   *
   * @param userMessage 用户输入文本
   * @param sessionId 会话 ID（用于构造 assistant 消息）
   */
  private async detectRuleCandidateHook(userMessage: string, sessionId: string): Promise<void> {
    // 未注入 ruleLearner 时跳过（向后兼容，零开销）
    if (!this.ruleLearner) {
      return;
    }
    try {
      // 步骤 1：检测纠正模式（非纠正模式直接返回，不触发候选规则检测）
      const detection = this.ruleLearner.detectCorrection(userMessage);
      if (!detection) {
        return;
      }
      // 步骤 2：提取规则候选（基于纠正内容推断 category / severity）
      const candidate: RuleCandidate = this.ruleLearner.extractCandidate(userMessage, detection.pattern);
      // 步骤 3：累积候选（同类纠正 occurrenceCount+1）
      const accumulated: RuleCandidate = this.ruleLearner.accumulateCandidate(candidate);
      // 步骤 4：判定是否推送确认请求（≥2 次才推送，§5.5.4 防误学红线）
      if (!this.ruleLearner.shouldPushConfirmation(accumulated)) {
        return;
      }
      // 步骤 5：推送确认请求
      const prompt =
        `检测到可能的候选规则：${accumulated.id} - ${accumulated.content}\n` +
        `分类: ${accumulated.category}，级别: ${accumulated.severity}\n` +
        `请回复 "/rule-confirm ${accumulated.id}" 确认或忽略。`;
      this.onAssistantMessage(this.buildAssistantMessage(sessionId, prompt, null), false);
    } catch (e) {
      // 候选规则检测失败不影响主对话循环，仅记录日志
      const errMsg = e instanceof Error ? e.message : String(e);
      this.onAssistantMessage(this.buildAssistantMessage(sessionId, `[RLIS] 候选规则检测异常：${errMsg}`, null), false);
    }
  }

  async activateSession(
    sessionId: string,
    controller?: AbortController,
    permissionPrompt?: UserPromptContent
  ): Promise<void> {
    const startedAt = Date.now();
    const { client, model, baseURL, temperature, thinkingEnabled, reasoningEffort, debugLogEnabled, notify, env } =
      this.createOpenAIClient();
    // Claude 主对话流式接入（2026-07-18 设计 §3）：方法开头一次性解析统一 LLM 客户端，循环内复用。
    // provider 判定取 llmClient.providerName 而非 settings.provider——单一事实源，
    // 且测试可经 createLLMClient 注入桩（B1 缝合点），无需改写 settings 文件。
    // provider=anthropic 且 apiKey 缺失时 createOpenAIClient() 与 createLLMClient() 同时返回空：
    // anthropicClient 为 null、走 OpenAI 分支并命中下方 !client →「API key not found」，失败语义与现状一致。
    const llmClient = this.createLLMClient();
    const anthropicClient = llmClient?.providerName === "anthropic" ? llmClient : null;
    const now = new Date().toISOString();
    rebuildSessionStateFromHistory(sessionId, this.listSessionMessages(sessionId));

    if (!client) {
      this.updateSessionEntry(sessionId, (entry) => ({
        ...entry,
        status: "failed",
        failReason: "API key not found",
        updateTime: now,
      }));
      this.onAssistantMessage(
        this.buildAssistantMessage(
          sessionId,
          "API key not found. Please configure ~/.deepcode/settings.json or ./.deepcode/settings.json.",
          null
        ),
        false
      );
      this.maybeNotifyTaskCompletion(sessionId, notify, startedAt, env);
      return;
    }

    const sessionController = controller ?? new AbortController();
    if (sessionController.signal.aborted) {
      this.updateSessionEntry(sessionId, (entry) => ({
        ...entry,
        status: "interrupted",
        failReason: "interrupted",
        updateTime: now,
      }));
      this.maybeNotifyTaskCompletion(sessionId, notify, startedAt, env);
      return;
    }

    this.updateSessionEntry(sessionId, (entry) => ({
      ...entry,
      status: "processing",
      updateTime: now,
    }));

    this.sessionControllers.set(sessionId, sessionController);

    try {
      const maxIterations = 80000; // about 1K RMB cost
      let toolCalls: unknown[] | null = null;

      for (let iteration = 0; iteration < maxIterations; iteration++) {
        if (this.isInterrupted(sessionId)) {
          return;
        }

        // EAG-P0：LoopGuard 共享上限保护检查（§5.2.1 / §5.12.3 AU-5）
        // 未注入 loopGuard 时跳过（向后兼容，使用内置 maxIterations=80000）
        // 注入后每次迭代开始检查 max_iterations/max_tokens/连续失败/手动终止
        if (this.loopGuard) {
          const guardCheck = this.loopGuard.check();
          if (!guardCheck.allowed) {
            // 终止原因映射到 session 状态
            const stopReason = guardCheck.stopReason ?? "manually_aborted";
            const isManualAbort = stopReason === "manually_aborted";
            this.updateSessionEntry(sessionId, (entry) => ({
              ...entry,
              status: isManualAbort ? "interrupted" : "failed",
              failReason: `LoopGuard: ${stopReason}`,
              updateTime: new Date().toISOString(),
            }));
            // 通知用户终止原因与消耗统计（便于审计与 /eag-usage 观察）
            this.onAssistantMessage(
              this.buildAssistantMessage(
                sessionId,
                `Loop terminated by guard: ${stopReason}.\nIterations: ${guardCheck.state.iterationsCompleted}/${this.loopGuard.getConfig().maxIterations}, Tokens: ${guardCheck.state.tokensConsumed}/${this.loopGuard.getConfig().maxTokens}, Consecutive failures: ${guardCheck.state.consecutiveFailures}/${this.loopGuard.getConfig().maxConsecutiveFailures}.`,
                null
              ),
              false
            );
            this.maybeNotifyTaskCompletion(sessionId, notify, startedAt, env);
            return;
          }
          // 退避建议（有失败记录时按指数退避+jitter 等待）
          if (guardCheck.suggestedWaitMs && guardCheck.suggestedWaitMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, guardCheck.suggestedWaitMs));
            // 等待期间可能被用户中断，等待后再次检查
            if (this.isInterrupted(sessionId)) {
              return;
            }
          }
        }

        const session = this.getSession(sessionId);
        if (session == null || session.status === "interrupted" || session.status === "failed") {
          return;
        }

        const pendingToolCallMessage = this.messageConverter.getTrailingPendingToolCallMessage(
          this.listSessionMessages(sessionId)
        );
        if (pendingToolCallMessage.toolCalls.length > 0) {
          const toolAppendResult = await this.appendToolMessages(sessionId, pendingToolCallMessage.toolCalls, {
            permissionOverrides: permissionPrompt?.permissions,
            messagePermissions: pendingToolCallMessage.message?.meta?.permissions,
          });
          await this.appendDeferredPermissionPrompt(sessionId, permissionPrompt, sessionController);
          // Permission replies are one-shot: do not reuse decisions or append the deferred user prompt again on later tool-call batches.
          permissionPrompt = undefined;
          if (this.isInterrupted(sessionId)) {
            return;
          }
          if (toolAppendResult.waitingForUser) {
            this.updateSessionEntry(sessionId, (entry) => ({
              ...entry,
              toolCalls: pendingToolCallMessage.toolCalls,
              status: "waiting_for_user",
              updateTime: new Date().toISOString(),
            }));
            return;
          }
        }

        const compactPromptTokenThreshold = getCompactPromptTokenThreshold(model);
        if (session.activeTokens > compactPromptTokenThreshold) {
          const message = this.buildAssistantMessage(
            sessionId,
            "The conversation is getting long, compacting...",
            null
          );
          message.meta = { asThinking: true };
          this.onAssistantMessage(message, false);
          await this.compactSession(sessionId, sessionController.signal);
        }

        const messages = this.messageConverter.buildMessages(
          this.listSessionMessages(sessionId),
          thinkingEnabled,
          model
        );
        const thinkingOptions = buildThinkingRequestOptions(thinkingEnabled, baseURL, reasoningEffort);
        // 仅流式调用一处三元分支，前后逻辑共享（2026-07-18 设计 §3 调用点形态）；
        // OpenAI 分支保持原样，Anthropic 分支聚合产物与 OpenAI 形态契约完全一致，
        // 主循环消费面（content/tool_calls/reasoning_content/refusal/usage）零改动。
        // 请求构建按 §6.1：messages 直接传 SessionMessage[]（converter 原生消费，不绕行 OpenAI 形态）；
        // tools 为 getTools 产物的纯字段提取；maxTokens/temperature 省略（client 回落 settings
        // 单一配置源，避免 Claude 侧每次调用产生误导性告警噪声）；signal 与 OpenAI 分支同源。
        const response = anthropicClient
          ? await this.createLlmMessageStream(
              anthropicClient,
              {
                messages: this.listSessionMessages(sessionId),
                tools: getTools(this.getPromptToolOptions(), this.mcpToolDefinitions).map((tool) => ({
                  name: tool.function.name,
                  description: tool.function.description,
                  parameters: tool.function.parameters,
                })),
                thinkingEnabled,
                signal: sessionController.signal,
              },
              sessionId,
              {
                enabled: debugLogEnabled,
                location: "SessionManager.activateSession",
                params: { iteration, temperature, thinkingEnabled, reasoningEffort },
              }
            )
          : await this.createChatCompletionStream(
              client,
              {
                model,
                ...(temperature !== undefined ? { temperature } : {}),
                messages,
                tools: getTools(this.getPromptToolOptions(), this.mcpToolDefinitions),
                ...thinkingOptions,
              },
              { signal: sessionController.signal },
              sessionId,
              {
                enabled: debugLogEnabled,
                location: "SessionManager.activateSession",
                baseURL,
                params: { iteration, temperature, thinkingEnabled, reasoningEffort },
              }
            );

        const message = response.choices?.[0]?.message;
        const rawContent = message?.content;
        const content = typeof rawContent === "string" ? rawContent : "";
        const rawToolCalls = (message as { tool_calls?: unknown[] } | undefined)?.tool_calls ?? null;
        toolCalls = this.normalizeLlmToolCalls(rawToolCalls);
        const rawThinking = (message as { reasoning_content?: unknown } | undefined)?.reasoning_content;
        const thinking = typeof rawThinking === "string" ? rawThinking : null;
        const refusal = (message as { refusal?: string } | undefined)?.refusal ?? null;
        // const html = content ? this.renderMarkdown(content) : "";

        if (this.isInterrupted(sessionId)) {
          return;
        }
        const assistantMessage = this.buildAssistantMessage(sessionId, content, toolCalls, thinking);
        const permissionPlan = toolCalls
          ? computeToolCallPermissions({
              sessionId,
              projectRoot: this.projectRoot,
              toolCalls,
              settings: this.getResolvedSettings().permissions,
              forceAskScopes: this.getSession(sessionId)?.planMode ? PLAN_MODE_FORCE_ASK_SCOPES : undefined,
              readPermissionExemptPaths: this.getSkillScanRoots().map((entry) => entry.root),
              resolveSnippetPath: (id, snippetId) => getSnippet(id, snippetId)?.filePath,
            })
          : null;
        if (permissionPlan) {
          assistantMessage.meta = {
            ...(assistantMessage.meta ?? {}),
            permissions: permissionPlan.permissions,
          };
        }
        this.appendSessionMessage(sessionId, assistantMessage);
        this.onAssistantMessage(assistantMessage, true);

        let waitingForUser = false;
        const responseUsage = response.usage ?? null;
        if (toolCalls) {
          if (permissionPlan?.askPermissions.length) {
            this.updateSessionEntry(sessionId, (entry) => ({
              ...entry,
              assistantReply: content,
              assistantThinking: thinking,
              assistantRefusal: refusal,
              toolCalls,
              usage: accumulateUsage(entry.usage, responseUsage),
              usagePerModel: accumulateUsagePerModel(entry.usagePerModel, model, responseUsage),
              activeTokens: getTotalTokens(responseUsage),
              status: "ask_permission",
              failReason: null,
              askPermissions: permissionPlan.askPermissions,
              updateTime: new Date().toISOString(),
            }));
            return;
          }
          const toolAppendResult = await this.appendToolMessages(sessionId, toolCalls, {
            messagePermissions: permissionPlan?.permissions,
          });
          waitingForUser = toolAppendResult.waitingForUser;
        }

        if (this.isInterrupted(sessionId)) {
          return;
        }

        this.updateSessionEntry(sessionId, (entry) => ({
          ...entry,
          assistantReply: content,
          assistantThinking: thinking,
          assistantRefusal: refusal,
          toolCalls,
          usage: accumulateUsage(entry.usage, responseUsage),
          usagePerModel: accumulateUsagePerModel(entry.usagePerModel, model, responseUsage),
          activeTokens: getTotalTokens(responseUsage),
          status: refusal ? "failed" : waitingForUser ? "waiting_for_user" : toolCalls ? "processing" : "completed",
          failReason: refusal ? refusal : entry.failReason,
          askPermissions: undefined,
          updateTime: new Date().toISOString(),
        }));

        if (refusal) {
          return;
        }

        if (waitingForUser) {
          return;
        }

        if (!toolCalls) {
          // EAG-P0：评估器外挂判定 + LoopGuard 迭代记录（§5.4 Goal Evaluator 接入主循环）
          // !toolCalls 表示 LLM 已给出最终回复且无工具调用，是评估器判定的接入点。
          // 未注入 evaluator 时保持现有行为（仅记录迭代后 return）。
          // 注入 evaluator 时外挂调用评估器，按 verdict 决定通知行为（EAG-P0 不做 FIX 回灌）。
          const evaluatorVerdict = await this.runEvaluatorHook(sessionId, content);
          // 记录迭代消耗（success 语义：未注入 evaluator 或评估器 verdict=pass）
          // 注：EAG-P0 阶段 recordIteration 主要用于状态跟踪与审计（/eag-usage 观测）；
          //     consecutiveFailures 累加不会触发终止（因主循环已 return）；
          //     EAG-P2 实现 FIX 回灌后，recordIteration 才会真正驱动终止决策。
          if (this.loopGuard) {
            const iterTokens = getTotalTokens(responseUsage);
            const iterSuccess = evaluatorVerdict === "pass" || evaluatorVerdict === null;
            this.loopGuard.recordIteration(iterTokens, iterSuccess);
          }
          return;
        }
      }

      this.updateSessionEntry(sessionId, (entry) => ({
        ...entry,
        status: "completed",
        updateTime: new Date().toISOString(),
      }));
      this.onAssistantMessage(
        this.buildAssistantMessage(
          sessionId,
          "The AI agent has taken several steps but hasn't reached a conclusion yet. Do you want to continue?",
          null
        ),
        false
      );
    } catch (error) {
      const errMessage = error instanceof Error ? error.message : String(error);
      const aborted = this.isAbortLikeError(error) || sessionController.signal.aborted;
      this.updateSessionEntry(sessionId, (entry) => ({
        ...entry,
        status: aborted ? "interrupted" : "failed",
        failReason: aborted ? "interrupted" : errMessage,
        updateTime: new Date().toISOString(),
      }));

      if (!aborted) {
        this.onAssistantMessage(this.buildAssistantMessage(sessionId, `Request failed: ${errMessage}`, null), false);
      }
    } finally {
      if (this.sessionControllers.get(sessionId) === sessionController) {
        this.sessionControllers.delete(sessionId);
      }
      this.maybeNotifyTaskCompletion(sessionId, notify, startedAt, env);
    }
  }

  /**
   * EAG-P0 评估器外挂 hook（§5.4 Goal Evaluator 接入主循环）
   *
   * 在主循环 !toolCalls 判定点（LLM 给出最终回复且无工具调用）外挂调用评估器。
   * 评估器按红线清单独立判定产出物，verdict 决定通知行为。
   *
   * EAG-P0 范围（最小必要集，评审 D-1 共识）：
   * - 未注入 evaluator 或 evaluatorRedlines → 返回 null（主循环保持现有 return 行为）
   * - pass → 返回 "pass"（任务完成，主循环 return，不追加消息）
   * - fix/human_checkpoint/stop_failure → 返回对应 verdict，并通知用户评估结果
   *   （EAG-P0 不做 FIX 回灌，仅通知；FIX 回灌留待 EAG-P2 CODING Loop）
   * - 评估器调用异常 → 返回 null（降级为无操作，不阻塞主循环 return）
   *
   * 设计权衡（§5.4 评审 A-3/A-4 共识）：
   * - 评估器与生成器严格分离（Generator 不给自己打分）
   * - 评估器为外挂式（可选注入），未注入时主循环行为零变化（V2 526 测试零回归）
   * - 评估器调用失败不阻塞主流程（降级语义，防评估器故障导致会话卡死）
   *
   * @param sessionId 会话 ID（用于构造 EvaluationContext.taskId 与消息回写）
   * @param assistantContent LLM 最终回复内容（作为 inlineArtifacts 注入评估器）
   * @returns 评估结论（"pass"/"fix"/"human_checkpoint"/"stop_failure"）；未注入或异常时返回 null
   */
  private async runEvaluatorHook(sessionId: string, assistantContent: string): Promise<EvaluationVerdict | null> {
    // 未注入 evaluator 或 evaluatorRedlines：降级为无操作（返回 null）
    // 注：EAG-P0 要求 evaluator + evaluatorRedlines 同时注入才生效，
    //     单独注入 evaluator 但无红线清单时无法判定（评估器需要红线清单作为判定依据）
    if (!this.evaluator || !this.evaluatorRedlines || this.evaluatorRedlines.length === 0) {
      return null;
    }

    try {
      // 构造评估上下文（EAG-P0 最小上下文，EAG-P2 起由 side-git diff 提供完整产出物）
      const context: EvaluationContext = {
        // EAG-P0 默认 coding Loop 类型；EAG-P1 起按当阶段 Loop 类型动态传入
        loopType: "coding",
        // EAG-P0 不跟踪迭代号（iteration 由 LoopGuard 独立管理）；
        // EAG-P2 起由 LoopGuard.getState().iterationsCompleted 提供
        iteration: 0,
        taskId: sessionId,
        // EAG-P0 不收集产出物文件路径（side-git diff 集成留待 EAG-P2）；
        // 评估器仅判定 LLM 最终回复内容
        artifactPaths: [],
        inlineArtifacts: [
          {
            path: "<assistant-reply>",
            content: assistantContent,
          },
        ],
        // 评估模式由评估器自身默认模式决定（STRICT/STANDARD/OFF）
        mode: this.evaluator.getDefaultMode(),
      };

      // 调用评估器（按红线清单逐条判定，返回 EvaluationReport）
      const report: EvaluationReport = await this.evaluator.evaluate(context, this.evaluatorRedlines);

      // 按 verdict 决定通知行为（EAG-P0：仅通知，不做 FIX 回灌）
      if (report.verdict !== "pass") {
        // 构造评估结果通知消息（让用户知道评估器判定结果与修复建议）
        // 注：verdictText 覆盖全部 4 种 verdict（pass 占位为空串，因上方已过滤 pass 分支）
        const verdictText: Record<EvaluationVerdict, string> = {
          pass: "",
          fix: "需修复（存在 BLOCKER/MAJOR 级违规）",
          human_checkpoint: "需人工确认（存在无法自动判定的问题）",
          stop_failure: "连续失败终止（连续失败次数超上限）",
        };

        // 汇总修复建议（verdict=fix 时附带，按优先级排序）
        const suggestions = report.fixSuggestions?.length
          ? `\n\n修复建议:\n${report.fixSuggestions.map((s) => `- ${s}`).join("\n")}`
          : "";

        // 评估器备注（LLM judge 模式下的推理摘要，或静态分析的统计信息）
        const notes = report.notes ? `\n\n评估备注: ${report.notes}` : "";

        this.onAssistantMessage(
          this.buildAssistantMessage(
            sessionId,
            `[EAG 评估器] ${verdictText[report.verdict]}\n` +
              `违规统计: BLOCKER=${report.blockerCount}, MAJOR=${report.majorCount}, WARNING=${report.warningCount}` +
              `\n评估耗时: ${report.durationMs}ms${notes}${suggestions}`,
            null
          ),
          false
        );
      }

      return report.verdict;
    } catch {
      // 评估器调用异常：降级为无操作（返回 null，不阻塞主循环 return）
      // 注：EAG-P0 评估器为外挂式，故障不应影响主流程；
      //     EAG-P2 起评估器为 STRICT 模式时故障应转 HUMAN_CHECKPOINT（此处留待 EAG-P2 增强）
      return null;
    }
  }

  async compactSession(sessionId: string, signal?: AbortSignal): Promise<void> {
    this.throwIfAborted(signal);
    // B1：非流式调用改经 provider 抽象层（createLLMClient 按 settings.provider 路由
    // OpenAI/Anthropic），不再直连 OpenAI SDK；无凭据时保持静默返回（旧 client:null 语义）
    const llmClient = this.createLLMClient();
    if (!llmClient) {
      return;
    }
    // 请求级参数（thinking 开关/采样温度）继续取自统一 settings 解析链，
    // 与主对话及旧 compact 通路同源，保证行为语义不变
    const { thinkingEnabled, temperature } = resolveCurrentSettings(this.projectRoot);
    const sessionMessages = this.listSessionMessages(sessionId).filter((message) => !message.compacted);
    if (sessionMessages.length === 0) {
      return;
    }

    const startIndex = sessionMessages.findIndex((message) => message.role !== "system");
    if (startIndex === -1) {
      return;
    }

    const searchStart = Math.floor(startIndex + ((sessionMessages.length - startIndex) * 2) / 3);
    let endIndex = -1;
    for (let i = Math.max(searchStart, startIndex); i < sessionMessages.length; i += 1) {
      if (sessionMessages[i].role !== "tool") {
        endIndex = i;
        break;
      }
    }
    if (endIndex === -1 || endIndex <= startIndex) {
      return;
    }

    // 提示词保持原有构造逻辑（getCompactPrompt），仅换成合成 SessionMessage 形态
    // 以适配 provider 层的统一转换入口（OpenAI/Anthropic converter 均按 user 文本处理）
    const compactPrompt = getCompactPrompt(sessionMessages.slice(startIndex, endIndex));
    const promptBuildTime = new Date().toISOString();
    const promptMessage: SessionMessage = {
      id: crypto.randomUUID(),
      sessionId,
      role: "user",
      content: compactPrompt,
      contentParams: null,
      messageParams: null,
      compacted: false,
      visible: false,
      createTime: promptBuildTime,
      updateTime: promptBuildTime,
    };

    let response: LLMResponse;
    try {
      response = await llmClient.createMessage({
        messages: [promptMessage],
        thinkingEnabled,
        ...(temperature !== undefined ? { temperature } : {}),
        signal: signal ?? null,
      });
    } catch (error) {
      // 保持错误可观测性（对齐旧 createChatCompletionStream 的 logApiError 行为），随后原样抛出
      logApiError({
        timestamp: new Date().toISOString(),
        location: "SessionManager.compactSession",
        requestId: crypto.randomUUID(),
        sessionId,
        model: llmClient.model,
        baseURL: llmClient.baseURL,
        error: {
          name: error instanceof Error ? error.name : "UnknownError",
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        },
        request: { provider: llmClient.providerName, messages: [{ role: "user", content: compactPrompt }] },
      });
      throw error;
    }
    this.throwIfAborted(signal);
    const llmResponse = response.content;
    const compactedSummary = llmResponse.replace(/<analysis>[\s\S]*?<\/analysis>/gi, "").trim();

    const now = new Date().toISOString();
    const responseUsage = toModelUsage(response.usage);
    this.updateSessionEntry(sessionId, (entry) => ({
      ...entry,
      usage: accumulateUsage(entry.usage, responseUsage),
      usagePerModel: accumulateUsagePerModel(entry.usagePerModel, llmClient.model, responseUsage),
      activeTokens: getTotalTokens(responseUsage),
      updateTime: now,
    }));

    for (let i = startIndex; i < endIndex; i += 1) {
      sessionMessages[i] = { ...sessionMessages[i], compacted: true, updateTime: now };
    }

    const summaryMessage: SessionMessage = {
      id: crypto.randomUUID(),
      sessionId,
      role: "system",
      content: `There are earlier parts of the conversation. Here is a summary: \n\n${compactedSummary}`,
      contentParams: null,
      messageParams: null,
      compacted: false,
      visible: false,
      createTime: now,
      updateTime: now,
      meta: {
        isSummary: true,
      },
    };
    sessionMessages.splice(endIndex, 0, summaryMessage);
    this.saveSessionMessages(sessionId, sessionMessages);
  }

  private getPromptToolOptions(): { model: string; webSearchEnabled: boolean } {
    return {
      model: this.getResolvedSettings().model,
      webSearchEnabled: true,
    };
  }

  private reportNewPrompt(): void {
    const { machineId, telemetryEnabled } = this.createOpenAIClient();
    reportNewPrompt({ enabled: telemetryEnabled ?? true, machineId });
  }

  interruptActiveSession(): void {
    const controller = this.activePromptController;
    if (controller && !controller.signal.aborted) {
      controller.abort();
    }

    const sessionId = this.activeSessionId;
    if (sessionId) {
      this.interruptSession(sessionId);
    }
  }

  interruptSession(sessionId: string): void {
    const session = this.getSession(sessionId);
    const processIds = this.getProcessIds(session?.processes ?? null);
    const killedPids: number[] = [];
    const failedPids: number[] = [];
    for (const pid of processIds) {
      const processControlKey = this.getProcessControlKey(sessionId, pid);
      this.processTimeoutControls.delete(processControlKey);
      this.liveProcessKeys.delete(processControlKey);
      if (killProcessTree(pid, "SIGKILL")) {
        killedPids.push(pid);
        continue;
      }
      failedPids.push(pid);
    }

    const controller = this.sessionControllers.get(sessionId);
    if (controller) {
      controller.abort();
      this.sessionControllers.delete(sessionId);
    }

    const now = new Date().toISOString();
    this.updateSessionEntry(sessionId, (entry) => ({
      ...entry,
      status: "interrupted",
      failReason: "interrupted",
      processes: null,
      updateTime: now,
    }));

    const contentParts = ["Interrupted."];
    if (killedPids.length > 0) {
      contentParts.push(`Killed processes: ${killedPids.join(", ")}.`);
    }
    if (failedPids.length > 0) {
      contentParts.push(`Failed to kill processes: ${failedPids.join(", ")}.`);
    }

    this.onAssistantMessage(this.buildUserMessage(sessionId, { text: contentParts.join(" ") }), false);
  }

  private isInterrupted(sessionId: string): boolean {
    return !this.sessionControllers.has(sessionId);
  }

  /**
   * Mark a session's permission as denied by the user.
   * Updates the session entry status and failReason so the denial is visible in the session list.
   */
  denySessionPermission(sessionId: string, reason?: string): void {
    const now = new Date().toISOString();
    this.updateSessionEntry(sessionId, (entry) => ({
      ...entry,
      status: "permission_denied",
      failReason: reason ?? "Permission denied by user",
      updateTime: now,
    }));
  }

  adjustActiveBashTimeout(deltaMs: number): BashTimeoutAdjustment | null {
    const sessionId = this.activeSessionId;
    if (!sessionId || !Number.isFinite(deltaMs)) {
      return null;
    }
    const session = this.getSession(sessionId);
    if (!session?.processes) {
      return null;
    }

    let selectedPid: string | null = null;
    for (const pid of session.processes.keys()) {
      if (this.processTimeoutControls.has(this.getProcessControlKey(sessionId, pid))) {
        selectedPid = pid;
      }
    }
    if (!selectedPid) {
      return null;
    }

    const control = this.processTimeoutControls.get(this.getProcessControlKey(sessionId, selectedPid));
    if (!control) {
      return null;
    }

    const current = control.getInfo();
    const next = control.setTimeoutMs(current.timeoutMs + deltaMs);
    this.updateSessionProcessTimeout(sessionId, selectedPid, next);
    return this.buildBashTimeoutAdjustment(selectedPid, next);
  }

  listSessions(): SessionEntry[] {
    const index = this.loadSessionsIndex();
    return index.entries;
  }

  getSession(sessionId: string): SessionEntry | null {
    const index = this.loadSessionsIndex();
    return index.entries.find((entry) => entry.id === sessionId) ?? null;
  }

  /**
   * Delete a session by its ID.
   * Removes the session entry from the index and cleans up associated resources
   * such as message files, in-memory state caches, working directory state,
   * session controllers, and tracked process timeout controls.
   * Returns true if the session was found and deleted, false otherwise.
   */
  deleteSession(sessionId: string): boolean {
    const index = this.loadSessionsIndex();
    const targetEntry = index.entries.find((entry) => entry.id === sessionId) ?? null;
    const nextEntries = index.entries.filter((entry) => entry.id !== sessionId);
    if (nextEntries.length === index.entries.length) {
      return false;
    }

    index.entries = nextEntries;
    this.saveSessionsIndex(index);
    this.cleanupSessionResources(sessionId, {
      removeMessages: true,
      processIds: this.getProcessIds(targetEntry?.processes ?? null),
    });
    return true;
  }

  /**
   * Rename a session by updating its summary (display title).
   * Returns true if the session was found and renamed, false otherwise.
   */
  renameSession(sessionId: string, summary: string): boolean {
    const trimmed = summary.trim();
    if (!trimmed) {
      return false;
    }
    const entry = this.getSession(sessionId);
    if (!entry) {
      return false;
    }
    this.updateSessionEntry(sessionId, (existing) => ({
      ...existing,
      summary: trimmed,
      updateTime: new Date().toISOString(),
    }));
    return true;
  }

  listSessionMessages(sessionId: string): SessionMessage[] {
    const messagePath = this.getSessionMessagesPath(sessionId);
    if (!fs.existsSync(messagePath)) {
      return [];
    }

    const raw = fs.readFileSync(messagePath, "utf8");
    const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
    const messages: SessionMessage[] = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as SessionMessage;
        messages.push(this.normalizeSessionMessage(parsed));
      } catch {
        // ignore malformed line
      }
    }
    return messages;
  }

  listUndoTargets(sessionId: string): UndoTarget[] {
    return this.listSessionMessages(sessionId)
      .map((message, index) => ({ message, index }))
      .filter(({ message }) => this.isUndoTargetMessage(message))
      .map(({ message, index }) => ({
        message,
        index,
        canRestoreCode: Boolean(
          message.checkpointHash && this.canRestoreCheckpointHash(sessionId, message.checkpointHash)
        ),
      }));
  }

  restoreSessionConversation(sessionId: string, messageId: string): SessionMessage[] {
    const messages = this.listSessionMessages(sessionId);
    const targetIndex = messages.findIndex((message) => message.id === messageId);
    if (targetIndex === -1) {
      throw new Error("Selected message was not found in this session.");
    }

    const keptMessages = messages.slice(0, targetIndex);
    this.saveSessionMessages(sessionId, keptMessages);
    const now = new Date().toISOString();
    const latestAssistant = [...keptMessages].reverse().find((message) => message.role === "assistant");
    const latestAssistantParams = latestAssistant?.messageParams as
      | { tool_calls?: unknown[]; reasoning_content?: string }
      | null
      | undefined;

    this.updateSessionEntry(sessionId, (entry) => ({
      ...entry,
      assistantReply: latestAssistant?.content ?? null,
      assistantThinking:
        typeof latestAssistantParams?.reasoning_content === "string" ? latestAssistantParams.reasoning_content : null,
      assistantRefusal: null,
      toolCalls: null,
      status: "completed",
      failReason: null,
      processes: null,
      updateTime: now,
    }));
    return keptMessages;
  }

  restoreSessionCode(sessionId: string, messageId: string): void {
    const message = this.listSessionMessages(sessionId).find((item) => item.id === messageId);
    if (!message) {
      throw new Error("Selected message was not found in this session.");
    }
    if (!message.checkpointHash) {
      throw new Error("Selected message has no code checkpoint.");
    }
    this.restoreCheckpointHash(sessionId, message.checkpointHash);
  }

  private normalizeSessionMessage(message: SessionMessage): SessionMessage {
    if (message.role !== "tool") {
      return message;
    }

    const nextMeta = message.meta ? { ...message.meta } : undefined;
    const normalizedParamsMd = this.buildToolParamsSnippet(nextMeta?.function ?? null);
    if (nextMeta && normalizedParamsMd) {
      nextMeta.paramsMd = normalizedParamsMd;
    }

    const normalizedResultMd = typeof message.content === "string" ? this.buildToolResultSnippet(message.content) : "";
    if (nextMeta && normalizedResultMd) {
      nextMeta.resultMd = normalizedResultMd;
    }

    return {
      ...message,
      visible: typeof message.content === "string" ? !this.isInvisibleExecution(message.content) : message.visible,
      meta: nextMeta,
    };
  }

  private getProjectStorage(): {
    projectCode: string;
    projectDir: string;
    sessionsIndexPath: string;
  } {
    const projectCode = getProjectCode(this.projectRoot);
    const projectDir = path.join(os.homedir(), ".deepcode", "projects", projectCode);
    const sessionsIndexPath = path.join(projectDir, "sessions-index.json");
    return { projectCode, projectDir, sessionsIndexPath };
  }

  private getFileHistory(): GitFileHistory {
    return new GitFileHistory(this.projectRoot, this.getFileHistoryGitDir());
  }

  private getFileHistoryGitDir(): string {
    const { projectDir } = this.getProjectStorage();
    return path.join(projectDir, "file-history", ".git");
  }

  private ensureFileHistorySession(sessionId: string): string | undefined {
    return this.getFileHistory().ensureSession(sessionId);
  }

  private getCurrentCheckpointHash(sessionId: string): string | undefined {
    return this.getFileHistory().getCurrentCheckpointHash(sessionId);
  }

  private recordUserPromptCheckpoint(sessionId: string): FileHistoryCheckpointResult {
    return this.getFileHistory().recordTrackedFilesCheckpoint(sessionId, "User prompt checkpoint");
  }

  private prepareFileMutationCheckpoint(sessionId: string, filePath: string): void {
    const fileHistory = this.getFileHistory();
    const previousHash = fileHistory.ensureSession(sessionId);
    if (!previousHash) {
      return;
    }
    this.updateLatestUserCheckpointHash(sessionId, undefined, previousHash);
    const nextHash = fileHistory.recordCheckpoint(sessionId, [filePath], "Pre-mutation checkpoint");
    if (nextHash && nextHash !== previousHash) {
      this.updateLatestUserCheckpointHash(sessionId, previousHash, nextHash);
    }
  }

  private recordFileMutationCheckpoint(sessionId: string, filePath: string): void {
    const fileHistory = this.getFileHistory();
    fileHistory.ensureSession(sessionId);
    fileHistory.recordCheckpoint(sessionId, [filePath], "File mutation checkpoint");
  }

  private updateLatestUserCheckpointHash(sessionId: string, previousHash: string | undefined, nextHash: string): void {
    const messages = this.listSessionMessages(sessionId);
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (!message || !this.isUndoTargetMessage(message)) {
        continue;
      }
      if (message.checkpointHash && message.checkpointHash !== previousHash) {
        return;
      }
      messages[index] = {
        ...message,
        checkpointHash: nextHash,
        updateTime: new Date().toISOString(),
      };
      this.saveSessionMessages(sessionId, messages);
      return;
    }
  }

  private canRestoreCheckpointHash(sessionId: string, checkpointHash: string): boolean {
    return this.getFileHistory().canRestore(sessionId, checkpointHash);
  }

  private restoreCheckpointHash(sessionId: string, checkpointHash: string): void {
    this.getFileHistory().restore(sessionId, checkpointHash);
  }

  private isUndoTargetMessage(message: SessionMessage): boolean {
    return message.role === "user" && message.visible && !message.compacted;
  }

  private ensureProjectDir(): string {
    const { projectDir } = this.getProjectStorage();
    fs.mkdirSync(projectDir, { recursive: true });
    return projectDir;
  }

  private loadSessionsIndex(): SessionsIndex {
    const { sessionsIndexPath } = this.getProjectStorage();
    this.ensureProjectDir();

    if (!fs.existsSync(sessionsIndexPath)) {
      return { version: 1, entries: [], originalPath: this.projectRoot };
    }

    try {
      const raw = fs.readFileSync(sessionsIndexPath, "utf8");
      const parsed = JSON.parse(raw) as SessionsIndex;
      const entries = Array.isArray(parsed.entries)
        ? parsed.entries.map((entry) => this.normalizeSessionEntry(entry))
        : [];
      return {
        version: 1,
        entries,
        originalPath: parsed.originalPath || this.projectRoot,
      };
    } catch {
      return { version: 1, entries: [], originalPath: this.projectRoot };
    }
  }

  private saveSessionsIndex(index: SessionsIndex): void {
    const { sessionsIndexPath } = this.getProjectStorage();
    this.ensureProjectDir();
    const normalized = {
      version: 1,
      entries: index.entries.map((entry) => ({
        ...entry,
        processes: this.serializeProcesses(entry.processes),
      })),
      originalPath: this.projectRoot,
    };
    fs.writeFileSync(sessionsIndexPath, JSON.stringify(normalized, null, 2), "utf8");
  }

  private getSessionMessagesPath(sessionId: string): string {
    const { projectDir } = this.getProjectStorage();
    return path.join(projectDir, `${sessionId}.jsonl`);
  }

  private removeSessionMessages(sessionIds: string[]): void {
    for (const sessionId of sessionIds) {
      const messagePath = this.getSessionMessagesPath(sessionId);
      try {
        if (fs.existsSync(messagePath)) {
          fs.unlinkSync(messagePath);
        }
      } catch {
        // ignore delete failures
      }
    }
  }

  private cleanupSessionResources(
    sessionId: string,
    options: { removeMessages: boolean; processIds?: number[] }
  ): void {
    const processIds = options.processIds ?? [];
    for (const pid of processIds) {
      const processControlKey = this.getProcessControlKey(sessionId, pid);
      if (!this.processTimeoutControls.has(processControlKey) && !this.liveProcessKeys.has(processControlKey)) {
        continue;
      }

      this.killTrackedProcess(processControlKey, pid);
    }

    clearSessionState(sessionId);
    clearSessionWorkingDir(sessionId);
    const controller = this.sessionControllers.get(sessionId);
    if (controller && !controller.signal.aborted) {
      controller.abort();
    }
    this.sessionControllers.delete(sessionId);
    if (options.removeMessages) {
      this.removeSessionMessages([sessionId]);
    }
  }

  private appendSessionMessage(sessionId: string, message: SessionMessage): void {
    this.ensureProjectDir();
    const messagePath = this.getSessionMessagesPath(sessionId);
    fs.appendFileSync(messagePath, `${JSON.stringify(message)}\n`, "utf8");
  }

  private saveSessionMessages(sessionId: string, messages: SessionMessage[]): void {
    this.ensureProjectDir();
    const messagePath = this.getSessionMessagesPath(sessionId);
    const payload = messages.map((message) => JSON.stringify(message)).join("\n");
    fs.writeFileSync(messagePath, payload ? `${payload}\n` : "", "utf8");
  }

  private updateSessionEntry(sessionId: string, updater: (entry: SessionEntry) => SessionEntry): SessionEntry | null {
    const index = this.loadSessionsIndex();
    const entryIndex = index.entries.findIndex((entry) => entry.id === sessionId);
    if (entryIndex === -1) {
      return null;
    }

    const updated = updater({ ...index.entries[entryIndex] });
    index.entries[entryIndex] = updated;
    this.saveSessionsIndex(index);
    this.onSessionEntryUpdated?.(updated);
    return updated;
  }

  private buildUserMessage(sessionId: string, prompt: UserPromptContent): SessionMessage {
    const now = new Date().toISOString();
    const imageParams =
      prompt.imageUrls
        ?.filter((url) => Boolean(url))
        .map((url) => ({
          type: "image_url",
          image_url: { url },
        })) ?? [];

    return {
      id: crypto.randomUUID(),
      sessionId,
      role: "user",
      content: prompt.text ?? "",
      contentParams: imageParams.length > 0 ? imageParams : null,
      messageParams: null,
      compacted: false,
      visible: true,
      createTime: now,
      updateTime: now,
      meta: { userPrompt: this.cloneUserPromptForMeta(prompt) },
      checkpointHash: this.getCurrentCheckpointHash(sessionId),
    };
  }

  private appendPlanModeTransitionMessages(sessionId: string, wasEnabled: boolean, isEnabled: boolean): void {
    if (wasEnabled === isEnabled) {
      return;
    }

    if (isEnabled) {
      const prompt = getPlanModePrompt();
      if (prompt) {
        this.appendSessionMessage(sessionId, this.buildSystemMessage(sessionId, prompt));
      }
      this.appendSessionMessage(sessionId, this.buildSystemMessage(sessionId, PLAN_MODE_ON_STATUS_MESSAGE));
      return;
    }

    this.appendSessionMessage(sessionId, this.buildSystemMessage(sessionId, PLAN_MODE_OFF_STATUS_MESSAGE));
  }

  private renderInitCommandPrompt(): string {
    const templatePath = path.join(getExtensionRoot(), "templates", "prompts", "init_command.md.ejs");
    const template = fs.readFileSync(templatePath, "utf8");
    return ejs.render(template, {
      agentsMdFile: this.getEffectiveProjectAgentsMdFile(),
    });
  }

  private getEffectiveProjectAgentsMdFile(): string | null {
    return this.loadProjectAgentInstructions()?.displayPath ?? null;
  }

  private loadProjectAgentInstructions(): { content: string; displayPath: string } | null {
    const candidatePaths = [
      {
        absolutePath: path.join(this.projectRoot, ".deepcode", "AGENTS.md"),
        displayPath: "./.deepcode/AGENTS.md",
      },
      {
        absolutePath: path.join(this.projectRoot, "AGENTS.md"),
        displayPath: "./AGENTS.md",
      },
    ];

    for (const candidatePath of candidatePaths) {
      const content = this.readNonEmptyFile(candidatePath.absolutePath);
      if (content) {
        return {
          content,
          displayPath: candidatePath.displayPath,
        };
      }
    }

    return null;
  }

  private readNonEmptyFile(filePath: string): string | null {
    try {
      if (!fs.existsSync(filePath)) {
        return null;
      }
      const content = fs.readFileSync(filePath, "utf8").trim();
      return content || null;
    } catch {
      return null;
    }
  }

  private loadAgentInstructions(): string | null {
    const projectInstructions = this.loadProjectAgentInstructions();
    if (projectInstructions) {
      return projectInstructions.content;
    }

    return this.readNonEmptyFile(path.join(os.homedir(), ".deepcode", "AGENTS.md"));
  }

  private buildSystemMessage(
    sessionId: string,
    content: string,
    contentParams: unknown | null = null,
    visible = false,
    meta?: MessageMeta
  ): SessionMessage {
    const now = new Date().toISOString();
    return {
      id: crypto.randomUUID(),
      sessionId,
      role: "system",
      content,
      contentParams,
      messageParams: null,
      compacted: false,
      visible,
      createTime: now,
      updateTime: now,
      meta,
    };
  }

  private buildSkillMessage(sessionId: string, content: string, skill: SkillInfo): SessionMessage {
    const now = new Date().toISOString();
    return {
      id: crypto.randomUUID(),
      sessionId,
      role: "system",
      content,
      contentParams: null,
      messageParams: null,
      compacted: false,
      visible: true,
      createTime: now,
      updateTime: now,
      meta: { skill: { ...skill, isLoaded: true } },
    };
  }

  private buildAssistantMessage(
    sessionId: string,
    content: string | null,
    toolCalls: unknown[] | null,
    reasoningContent?: string | null
  ): SessionMessage {
    const now = new Date().toISOString();
    const hasReasoningContent = reasoningContent != null;
    const messageParams: { tool_calls?: unknown[]; reasoning_content?: string } | null =
      toolCalls || hasReasoningContent ? {} : null;
    if (toolCalls) {
      messageParams!.tool_calls = toolCalls;
    }
    if (hasReasoningContent) {
      messageParams!.reasoning_content = reasoningContent;
    }
    return {
      id: crypto.randomUUID(),
      sessionId,
      role: "assistant",
      content,
      contentParams: null,
      messageParams,
      compacted: false,
      visible: (content || reasoningContent || "").trim() ? true : false,
      createTime: now,
      updateTime: now,
      meta: toolCalls ? { asThinking: true } : undefined,
    };
  }

  private generateToolCallId(): string {
    return crypto.randomBytes(16).toString("hex");
  }

  private normalizeLlmToolCalls(rawToolCalls: unknown[] | null | undefined): unknown[] | null {
    if (!Array.isArray(rawToolCalls) || rawToolCalls.length === 0) {
      return null;
    }

    return rawToolCalls.map((toolCall) => {
      if (!toolCall || typeof toolCall !== "object" || Array.isArray(toolCall)) {
        return toolCall;
      }

      const record = toolCall as Record<string, unknown>;
      const id = typeof record.id === "string" ? record.id.trim() : "";
      if (id) {
        return toolCall;
      }

      return {
        ...record,
        id: this.generateToolCallId(),
      };
    });
  }

  private buildToolMessage(
    sessionId: string,
    toolCallId: string,
    content: string,
    toolFunction: unknown | null
  ): SessionMessage {
    const now = new Date().toISOString();
    const paramsMd = this.buildToolParamsSnippet(toolFunction);
    const resultMd = this.buildToolResultSnippet(content);
    const isInvisibleExecution = this.isInvisibleExecution(content);
    return {
      id: crypto.randomUUID(),
      sessionId,
      role: "tool",
      content,
      contentParams: null,
      messageParams: { tool_call_id: toolCallId },
      compacted: false,
      visible: !isInvisibleExecution,
      createTime: now,
      updateTime: now,
      meta: {
        function: toolFunction ?? undefined,
        paramsMd,
        resultMd,
      },
    };
  }

  private async appendToolMessages(
    sessionId: string,
    toolCalls: unknown[],
    options: {
      permissionOverrides?: UserToolPermission[];
      messagePermissions?: MessageToolPermission[];
    } = {}
  ): Promise<{ waitingForUser: boolean }> {
    const hooks: ToolExecutionHooks = {
      onProcessStart: (pid, command) => this.addSessionProcess(sessionId, pid, command),
      onProcessExit: (pid) => this.removeSessionProcess(sessionId, pid),
      onProcessStdout: (pid, chunk) => this.onProcessStdout?.(Number(pid), chunk),
      onProcessTimeoutControl: (pid, control) => this.setSessionProcessTimeoutControl(sessionId, pid, control),
      onBackgroundProcessComplete: (completion) => this.addBackgroundProcessCompletionMessage(sessionId, completion),
      onBeforeFileMutation: (filePath) => this.prepareFileMutationCheckpoint(sessionId, filePath),
      onAfterFileMutation: (filePath) => this.recordFileMutationCheckpoint(sessionId, filePath),
      shouldStop: () => this.isInterrupted(sessionId),
    };
    const parsedToolCalls = toolCalls
      .map((toolCall) => parseToolCallForPermissions(toolCall))
      .filter((toolCall): toolCall is PermissionToolCall => Boolean(toolCall));
    const toolExecutions: ToolCallExecution[] = [];
    for (const toolCall of parsedToolCalls) {
      if (hooks.shouldStop?.()) {
        break;
      }
      const blockedResult = buildPermissionToolExecution(toolCall, options);
      if (blockedResult) {
        toolExecutions.push(blockedResult);
        continue;
      }
      const executions = await this.toolExecutor.executeToolCalls(sessionId, [toolCall], hooks);
      toolExecutions.push(...executions);
    }
    if (this.isInterrupted(sessionId)) {
      return { waitingForUser: false };
    }
    let waitingForUser = false;
    const followUpMessages: SessionMessage[] = [];
    for (const execution of toolExecutions) {
      if (execution.result.awaitUserResponse === true) {
        waitingForUser = true;
      }
      const toolFunction = this.messageConverter.findToolFunction(toolCalls, execution.toolCallId);
      const toolMessage = this.buildToolMessage(sessionId, execution.toolCallId, execution.content, toolFunction);
      this.appendSessionMessage(sessionId, toolMessage);
      this.onAssistantMessage(toolMessage, true);

      for (const followUpMessage of execution.result.followUpMessages ?? []) {
        if (followUpMessage.role !== "system") {
          continue;
        }
        followUpMessages.push(
          this.buildSystemMessage(sessionId, followUpMessage.content, followUpMessage.contentParams ?? null)
        );
      }
    }

    for (const followUpMessage of followUpMessages) {
      this.appendSessionMessage(sessionId, followUpMessage);
    }
    return { waitingForUser };
  }

  private cloneUserPromptForMeta(prompt: UserPromptContent): UserPromptContent {
    return {
      text: prompt.text,
      imageUrls: prompt.imageUrls ? [...prompt.imageUrls] : undefined,
      skills: prompt.skills ? prompt.skills.map((skill) => ({ ...skill })) : undefined,
      permissions: prompt.permissions ? prompt.permissions.map((permission) => ({ ...permission })) : undefined,
      alwaysAllows: prompt.alwaysAllows ? [...prompt.alwaysAllows] : undefined,
      planMode: prompt.planMode,
      // EAG-P2 批次 9 S5：透传 messageParams 元数据（含 codingLoopRequest 等）
      messageParams: prompt.messageParams ? { ...prompt.messageParams } : undefined,
    };
  }

  private hasTrailingPendingToolCalls(sessionId: string): boolean {
    return (
      this.messageConverter.getTrailingPendingToolCallMessage(this.listSessionMessages(sessionId)).toolCalls.length > 0
    );
  }

  private async appendDeferredPermissionPrompt(
    sessionId: string,
    userPrompt: UserPromptContent | undefined,
    controller: AbortController
  ): Promise<void> {
    if (!userPrompt || this.isContinuePrompt(userPrompt)) {
      return;
    }
    const text = userPrompt.text ?? "";
    const hasUserContent =
      text.trim().length > 0 ||
      (Array.isArray(userPrompt.imageUrls) && userPrompt.imageUrls.length > 0) ||
      (Array.isArray(userPrompt.skills) && userPrompt.skills.length > 0);
    if (!hasUserContent) {
      return;
    }
    this.reportNewPrompt();
    const signal = controller.signal;
    const userMessage = this.buildUserMessage(sessionId, userPrompt);
    this.appendSessionMessage(sessionId, userMessage);
    if (userPrompt.text) {
      const skills = await this.listSkills(sessionId);
      const skillNames = await this.identifyMatchingSkillNames(skills, userPrompt.text, { signal, sessionId });
      this.throwIfAborted(signal);
      const skillSet = new Set(skillNames);
      const matchedSkill = skills.filter((skill) => skillSet.has(skill.name));
      if (Array.isArray(userPrompt.skills)) {
        userPrompt.skills.push(...matchedSkill);
      } else if (matchedSkill.length > 0) {
        userPrompt.skills = matchedSkill;
      }
    }
    userPrompt.skills = await this.normalizeSkills(userPrompt.skills, sessionId);
    this.throwIfAborted(signal);
    this.appendSkillMessages(sessionId, userPrompt.skills);
  }

  private buildToolParamsSnippet(toolFunction: unknown | null): string {
    if (!toolFunction || typeof toolFunction !== "object") {
      return "";
    }
    const args = (toolFunction as { arguments?: unknown }).arguments;
    const toolName = (toolFunction as { name?: unknown }).name;
    if (typeof args !== "string") {
      return "";
    }
    const trimmed = args.trim();
    if (!trimmed) {
      return "";
    }
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return this.formatToolParamsSnippet(
          typeof toolName === "string" ? toolName : null,
          parsed as Record<string, unknown>
        );
      }
    } catch {
      // fall back to raw string
    }
    return trimmed;
  }

  private formatToolParamsSnippet(toolName: string | null, args: Record<string, unknown>): string {
    if (toolName === "bash") {
      const command = typeof args.command === "string" ? args.command.trim() : "";
      const description = typeof args.description === "string" ? args.description.trim() : "";
      if (command && description) {
        return `${command}  # ${description}`;
      }
      if (command) {
        return command;
      }
      if (description) {
        return description;
      }
    } else if (toolName === "UpdatePlan") {
      return typeof args.explanation === "string" ? args.explanation.trim() : "";
    } else if (toolName === "write") {
      return typeof args.file_path === "string" ? args.file_path.trim() : "";
    } else if (toolName === "edit") {
      const filePath = typeof args.file_path === "string" ? args.file_path.trim() : "";
      if (filePath) {
        return filePath;
      }
      return typeof args.snippet_id === "string" ? args.snippet_id.trim() : "";
    }

    const firstKey = Object.keys(args)[0];
    if (!firstKey) {
      return "";
    }

    const value = args[firstKey];
    const text = typeof value === "string" ? value : JSON.stringify(value);
    if (toolName === "read" && text.startsWith(this.projectRoot)) {
      return text.slice(this.projectRoot.length).replace(/^[\\/]/, "");
    }
    return text;
  }

  private buildToolResultSnippet(content: string): string {
    const trimmed = content.trim();
    if (!trimmed) {
      return "";
    }

    const maxLength = 2000;

    try {
      const parsed = JSON.parse(content) as { output?: unknown };
      if (parsed.output !== undefined) {
        if (typeof parsed.output === "string") {
          return this.formatToolResultSnippet(parsed.output, maxLength);
        }
        return this.formatToolResultSnippet(JSON.stringify(parsed.output), maxLength);
      }
    } catch {
      // fall back to raw content
    }

    return this.formatToolResultSnippet(content, maxLength);
  }

  private formatToolResultSnippet(value: string, maxLength: number): string {
    if (value.length <= maxLength) {
      return value;
    }
    return `${value.slice(0, maxLength)}... (total ${value.length} chars)`;
  }

  private isInvisibleExecution(content: string): boolean {
    if (!content.trim()) {
      return false;
    }
    try {
      const parsed = JSON.parse(content) as { name?: unknown; ok?: unknown };
      return parsed.name === "bash" && parsed.ok !== true;
    } catch {
      return false;
    }
  }

  private maybeNotifyTaskCompletion(
    sessionId: string,
    notifyCommand: string | undefined,
    startedAt: number,
    configuredEnv: Record<string, string> = {}
  ): void {
    if (!notifyCommand) {
      return;
    }

    const session = this.getSession(sessionId);
    if (!session || (session.status !== "completed" && session.status !== "failed")) {
      return;
    }

    // Find the last assistant message body for the BODY env variable.
    let body: string | undefined;
    const messages = this.listSessionMessages(sessionId);
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg && msg.role === "assistant" && msg.content) {
        body = msg.content;
        break;
      }
    }

    launchNotifyScript(notifyCommand, Date.now() - startedAt, this.projectRoot, undefined, configuredEnv, {
      status: session.status,
      failReason: session.failReason ?? undefined,
      body,
      title: session.summary ?? undefined,
    });
  }

  private addSessionProcess(sessionId: string, processId: string | number, command: string): void {
    const now = new Date().toISOString();
    this.liveProcessKeys.add(this.getProcessControlKey(sessionId, processId));
    this.updateSessionEntry(sessionId, (entry) => {
      const processes = new Map(entry.processes ?? []);
      processes.set(String(processId), { startTime: now, command });
      return {
        ...entry,
        processes,
        updateTime: now,
      };
    });
  }

  private addBackgroundProcessCompletionMessage(
    sessionId: string,
    completion: {
      command: string;
      outputPath: string;
      ok: boolean;
      exitCode: number | null;
      signal: string | null;
      error?: string;
      completedAtMs: number;
      startedAtMs: number;
    }
  ): void {
    const status = completion.ok ? "completed" : "failed";
    const exitText =
      completion.exitCode !== null
        ? `exit code ${completion.exitCode}`
        : completion.signal
          ? `signal ${completion.signal}`
          : completion.error || "unknown status";
    const durationMs = Math.max(0, completion.completedAtMs - completion.startedAtMs);
    const baseContent =
      `Background command "${completion.command}" ${status} with ${exitText} ` +
      `after ${this.formatBackgroundDuration(durationMs)}. Output: ${completion.outputPath}`;
    const logTail = completion.ok ? null : this.buildBackgroundFailureLogTailSlice(completion.outputPath);
    const content = logTail ? `${baseContent}\n${logTail}` : baseContent;
    this.addSessionSystemMessage(sessionId, content, true);
  }

  private buildBackgroundFailureLogTailSlice(outputPath: string): string | null {
    const tail = this.readTextFileTail(outputPath, BACKGROUND_FAILURE_LOG_TAIL_CHARS);
    if (!tail || !tail.content) {
      return null;
    }
    const prefix = tail.truncated ? `(${tail.totalBytes} bytes)...\n` : "";
    return [
      `<background_task_failure_log path="${outputPath}">`,
      `${prefix}${tail.content}`,
      "</background_task_failure_log>",
    ].join("\n");
  }

  private readTextFileTail(
    filePath: string,
    maxChars: number
  ): { content: string; totalBytes: number; truncated: boolean } | null {
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile() || stat.size <= 0) {
        return null;
      }
      const content = readTextFileWithMetadata(filePath).content;
      return {
        content: content.slice(-maxChars).trimEnd(),
        totalBytes: stat.size,
        truncated: content.length > maxChars,
      };
    } catch {
      return null;
    }
  }

  private formatBackgroundDuration(durationMs: number): string {
    if (durationMs < 1000) {
      return `${durationMs}ms`;
    }
    const seconds = Math.round(durationMs / 1000);
    if (seconds < 60) {
      return `${seconds}s`;
    }
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
  }

  private removeSessionProcess(sessionId: string, processId: string | number): void {
    const now = new Date().toISOString();
    const processControlKey = this.getProcessControlKey(sessionId, processId);
    this.processTimeoutControls.delete(processControlKey);
    this.liveProcessKeys.delete(processControlKey);
    this.updateSessionEntry(sessionId, (entry) => {
      const processes = new Map(entry.processes ?? []);
      processes.delete(String(processId));
      return {
        ...entry,
        processes: processes.size > 0 ? processes : null,
        updateTime: now,
      };
    });
  }

  private setSessionProcessTimeoutControl(
    sessionId: string,
    processId: string | number,
    control: ProcessTimeoutControl | null
  ): void {
    const key = this.getProcessControlKey(sessionId, processId);
    if (!control) {
      this.processTimeoutControls.delete(key);
      return;
    }

    this.processTimeoutControls.set(key, control);
    this.updateSessionProcessTimeout(sessionId, processId, control.getInfo());
  }

  private updateSessionProcessTimeout(sessionId: string, processId: string | number, info: ProcessTimeoutInfo): void {
    const now = new Date().toISOString();
    this.updateSessionEntry(sessionId, (entry) => {
      const processes = new Map(entry.processes ?? []);
      const pid = String(processId);
      const processInfo = processes.get(pid);
      if (!processInfo) {
        return entry;
      }
      processes.set(pid, {
        ...processInfo,
        timeoutMs: info.timeoutMs,
        deadlineAt: new Date(info.deadlineAtMs).toISOString(),
        timedOut: info.timedOut,
      });
      return {
        ...entry,
        processes,
        updateTime: now,
      };
    });
  }

  private buildBashTimeoutAdjustment(processId: string, info: ProcessTimeoutInfo): BashTimeoutAdjustment {
    return {
      processId,
      timeoutMs: info.timeoutMs,
      deadlineAt: new Date(info.deadlineAtMs).toISOString(),
      timedOut: info.timedOut,
    };
  }

  private getProcessControlKey(sessionId: string, processId: string | number): string {
    return `${sessionId}:${String(processId)}`;
  }

  private killLiveProcesses(): void {
    for (const processControlKey of Array.from(this.liveProcessKeys)) {
      const processId = this.getProcessIdFromControlKey(processControlKey);
      if (processId === null) {
        this.liveProcessKeys.delete(processControlKey);
        continue;
      }
      this.killTrackedProcess(processControlKey, processId);
    }
  }

  private killTrackedProcess(processControlKey: string, processId: number): void {
    const killedGroup = killProcessTree(processId, "SIGKILL");
    if (!killedGroup) {
      try {
        process.kill(processId, "SIGKILL");
      } catch {
        // Ignore process-kill failures during cleanup.
      }
    }
    this.processTimeoutControls.delete(processControlKey);
    this.liveProcessKeys.delete(processControlKey);
  }

  private getProcessIdFromControlKey(processControlKey: string): number | null {
    const separatorIndex = processControlKey.lastIndexOf(":");
    const rawProcessId = separatorIndex >= 0 ? processControlKey.slice(separatorIndex + 1) : processControlKey;
    const processId = Number(rawProcessId);
    return Number.isInteger(processId) && processId > 0 ? processId : null;
  }

  private getProcessIds(processes: Map<string, SessionProcessEntry> | null): number[] {
    if (!processes) {
      return [];
    }
    const ids: number[] = [];
    for (const pid of processes.keys()) {
      const parsed = Number(pid);
      if (Number.isInteger(parsed) && parsed > 0) {
        ids.push(parsed);
      }
    }
    return ids;
  }

  private normalizeSessionEntry(entry: unknown): SessionEntry {
    const value = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
    return {
      id: typeof value.id === "string" ? value.id : crypto.randomUUID(),
      summary: typeof value.summary === "string" ? value.summary : null,
      assistantReply: typeof value.assistantReply === "string" ? value.assistantReply : null,
      assistantThinking: typeof value.assistantThinking === "string" ? value.assistantThinking : null,
      assistantRefusal: typeof value.assistantRefusal === "string" ? value.assistantRefusal : null,
      toolCalls: Array.isArray(value.toolCalls) ? value.toolCalls : null,
      status: this.normalizeSessionStatus(value.status),
      failReason: typeof value.failReason === "string" ? value.failReason : null,
      usage: (value.usage as ModelUsage) ?? null,
      usagePerModel: this.normalizeUsagePerModel(value),
      activeTokens: typeof value.activeTokens === "number" ? value.activeTokens : 0,
      createTime: typeof value.createTime === "string" ? value.createTime : new Date().toISOString(),
      updateTime: typeof value.updateTime === "string" ? value.updateTime : new Date().toISOString(),
      processes: this.deserializeProcesses(value.processes),
      askPermissions: normalizeAskPermissions(value.askPermissions),
      planMode: value.planMode === true,
    };
  }

  private normalizeSessionStatus(status: unknown): SessionStatus {
    if (
      status === "failed" ||
      status === "pending" ||
      status === "processing" ||
      status === "waiting_for_user" ||
      status === "completed" ||
      status === "interrupted" ||
      status === "ask_permission" ||
      status === "permission_denied"
    ) {
      return status;
    }
    return "pending";
  }

  private normalizeUsagePerModel(entry: Record<string, unknown>): Record<string, ModelUsage> | null {
    if (!Object.prototype.hasOwnProperty.call(entry, "usagePerModel")) {
      return null;
    }
    if (!isUsageRecord(entry.usagePerModel)) {
      return null;
    }
    const usagePerModel: Record<string, ModelUsage> = {};
    for (const [model, usage] of Object.entries(entry.usagePerModel)) {
      if (!model || !isUsageRecord(usage)) {
        continue;
      }
      usagePerModel[model] = usage as ModelUsage;
    }
    return usagePerModel;
  }

  private deserializeProcesses(value: unknown): Map<string, SessionProcessEntry> | null {
    if (!value || typeof value !== "object") {
      return null;
    }
    const processes = new Map<string, SessionProcessEntry>();
    for (const [pid, entry] of Object.entries(value as Record<string, unknown>)) {
      if (!pid) {
        continue;
      }
      if (typeof entry === "string") {
        // Backward compatibility for old format where just stored start time
        processes.set(pid, { startTime: entry, command: "Running process..." });
      } else if (typeof entry === "object" && entry !== null) {
        const obj = entry as {
          startTime?: unknown;
          command?: unknown;
          timeoutMs?: unknown;
          deadlineAt?: unknown;
          timedOut?: unknown;
        };
        const startTime = typeof obj.startTime === "string" ? obj.startTime : new Date().toISOString();
        const command = typeof obj.command === "string" ? obj.command : "Running process...";
        processes.set(pid, {
          startTime,
          command,
          timeoutMs: typeof obj.timeoutMs === "number" ? obj.timeoutMs : undefined,
          deadlineAt: typeof obj.deadlineAt === "string" ? obj.deadlineAt : undefined,
          timedOut: typeof obj.timedOut === "boolean" ? obj.timedOut : undefined,
        });
      }
    }
    return processes.size > 0 ? processes : null;
  }

  private serializeProcesses(
    processes: Map<string, SessionProcessEntry> | null
  ): Record<string, SessionProcessEntry> | null {
    if (!processes || processes.size === 0) {
      return null;
    }
    const serialized: Record<string, SessionProcessEntry> = {};
    for (const [pid, entry] of processes.entries()) {
      serialized[pid] = entry;
    }
    return serialized;
  }
}
