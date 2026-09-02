import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";
import matter from "gray-matter";
import ejs from "ejs";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { launchNotifyScript } from "./common/notify";
import { buildThinkingRequestOptions } from "./common/openai-thinking";
// 合并说明：DEEPSEEK_V4_MODELS 为 fork 侧 compact 阈值特判所需；buildSkillCatalogPrompt
// 为上游 v0.3.1 技能目录提示词所需；getDefaultSkillPrompt 为 fork 侧默认技能所需，全部保留
import { DEEPSEEK_V4_MODELS } from "./common/model-capabilities";
import { readTextFileWithMetadata } from "./common/file-utils";
import {
  buildSkillCatalogPrompt,
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
  // 合并说明：CreateLLMClient 为 fork 侧 B1 统一 LLM 工厂类型；PluginRateLimitedTool /
  // SharpLoader / ToolExecutionFollowUpMessage / ToolExecutionResult 为上游 v0.3.1
  // 多模态与限流插件所需类型，两侧类型全部保留
  type CreateLLMClient,
  type PluginRateLimitedTool,
  type ProcessTimeoutControl,
  type ProcessTimeoutInfo,
  type SharpLoader,
  type ToolCallExecution,
  type ToolExecutionFollowUpMessage,
  type ToolExecutionHooks,
  type ToolExecutionResult,
} from "./tools/executor";
import { McpManager } from "./mcp/mcp-manager";
import type { McpServerConfig, PermissionScope, PermissionSettings } from "./settings";
import { resolveCurrentSettings } from "./settings";
// 上游 v0.3.1：Files API 默认值与自动 compact 窗口计算，供 filesApi / autoCompactWindow 消费
import {
  DEFAULT_FILE_EXPIRES_AFTER_SECONDS,
  DEFAULT_FILE_QUOTA_CLEANUP_BATCH,
  DEFAULT_FILE_REFRESH_MARGIN_SECONDS,
  DEFAULT_FILES_API_TIMEOUT_MS,
  DEFAULT_MAX_REQUEST_FILES_BYTES,
  getDefaultAutoCompactWindow,
} from "./settings";
// fork 侧 B1：ProviderFactory 统一 LLM provider 路由（openai/anthropic）
import { ProviderFactory } from "./providers/provider-factory";
import type { LLMClient, LLMResponse, LLMToolDefinition, LLMUsage } from "./providers/llm-provider";
// Usage 追踪模块（从 session.ts 抽取，见 docs/dev/review.md CRITICAL-1 模块 2）
// 包含：isUsageRecord / addUsageValue / accumulateUsage / usageWithRequestCount /
// accumulateUsagePerModel / getTotalTokens / toModelUsage / ModelUsage 类型
import {
  isUsageRecord,
  addUsageValue,
  accumulateUsage,
  usageWithRequestCount,
  accumulateUsagePerModel,
  getTotalTokens,
  toModelUsage,
  type ModelUsage,
} from "./usage-tracker";
// 向后兼容：re-export ModelUsage 类型，保持 index.ts 与外部消费者不变
export type { ModelUsage } from "./usage-tracker";
// SkillManager 技能管理模块（从 session.ts 抽取，见 docs/dev/review.md CRITICAL-1 模块 3）
// 包含：getSkillScanRoots / getBundledSkillsRoot / listSkills / resolveSkillPath /
// buildSkillPrompt / readSkillInfo / getSkillKey / getSkillKeyByName /
// getLoadedSkillKeys / dedupeSkills / normalizeSkills
import { SkillManager } from "./skill-manager";
// StreamAggregator 流式聚合工具模块（从 session.ts 抽取，见 docs/dev/review.md CRITICAL-1 模块 1）
// 包含：estimateStreamTokens / formatEstimatedTokens / isAbortLikeError / throwIfAborted / CJK_REGEX
import {
  estimateStreamTokens as estimateStreamTokensImpl,
  formatEstimatedTokens as formatEstimatedTokensImpl,
  isAbortLikeError as isAbortLikeErrorImpl,
  throwIfAborted as throwIfAbortedImpl,
} from "./stream-aggregator";
import { logApiError } from "./common/error-logger";
import { logOpenAIChatCompletionDebug, normalizeDebugError } from "./common/debug-logger";
import { describeLlmError, getLlmErrorDetails } from "./common/llm-error";
// V2 codemap 工具注入：将 codemap_query / impact_analysis / flow_trace / risk_scan
// 4 个工具注册到 ToolExecutor，图谱不可用时降级返回空结果（NFR-4 零回归）
import { registerCodemapTools } from "./v2/tools/tool-executor-registry";
import { DefaultSymbolGraphAdapter } from "./v2/context/default-symbol-graph-adapter";
// ADR-DI-001 中断管理 LLM 工具注入：将 background_task / list_tasks / cancel_task /
// inject_message 4 个工具注册到 ToolExecutor，未注入 taskRegistry 时降级返回
// "feature unavailable" 错误（与 codemap 工具同构，§7.3 LLM 工具注册）
import { registerInterruptTools } from "./interrupts/register-tools";
import type { InterruptibleSessionManager } from "./interrupts/llm-tools";
import { killProcessTree } from "./common/process-tree";
// fork 侧：文件历史协调器（会话文件历史记录）
import { FileHistoryCoordinator } from "./file-history-coordinator";
// 上游 v0.3.1：基于 git 的文件历史检查点，供多模态/文件历史回滚场景消费
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
// V2 Session 上下文钩子：可选注入，未注入时 OpenAIMessageConverter 行为与 v1 一致
import type { SessionContextHook } from "./v2/integration/session-hook";
// === EAG 模块导入（@experimental）===
// 以下 EAG 相关导入均为可选注入能力，未注入时主流程零回归。
// 详细设计决策见 docs/dev/ADR-EAG-001-experimental-status.md。
// 涉及模块：LoopGuard / Evaluator / Coding / Testing / Design / LongHorizon / RLIS /
// DevOps / Autonomous / Graph / Dynamic / Interrupts
import type { LoopGuard } from "./common/loop-guard";
import type {
  IndependentEvaluator,
  RedlineDefinition,
  EvaluationContext,
  EvaluationReport,
  EvaluationVerdict,
} from "./eag/evaluator/types";
import type { CodingOrchestrator } from "./eag/coding/index";
import type { CodingLoopRequest, CodingLoopResult, PkcAccessor } from "./eag/coding/types";
import type { DesignLoopOrchestrator } from "./eag/design/design-orchestrator";
import type { DesignLoopInput, DesignLoopResult } from "./eag/design/design-models";
import type { TestingOrchestrator } from "./eag/testing/index";
import type { TestingLoopRequest, TestingLoopResult } from "./eag/testing/types";
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
} from "./eag/long-horizon/index";
import type {
  EagRunRequest,
  EagRunResult,
  EagResumeRequest,
  EagStatusRequest,
  EagStatusResult,
} from "./eag/long-horizon/index";
import { EagCommandParser } from "./eag/cli/index";
import type { DevOpsOrchestrator } from "./eag/devops/devops-orchestrator";
import type { DevOpsContext, DevOpsResult } from "./eag/devops/types";
import type { DeployRequest } from "./eag/cli/eag-command-parser";
import type { AutonomousOrchestrator } from "./eag/p5/autonomous-orchestrator";
import {
  EagAutonomousCommandHandler,
  extractEagAutonomousRequestFromPrompt,
  extractEagAutonomousStatusRequestFromPrompt,
  extractEagAutonomousStopRequestFromPrompt,
} from "./eag/cli/index";
import type {
  EagAutonomousRequest,
  EagAutonomousCommandResult,
  EagAutonomousStatusRequest,
  EagAutonomousStopRequest,
} from "./eag/cli/index";
import type { GraphLoopOrchestratorOptions } from "./eag/graph/graph-loop-protocols";
import { EagGraphCommandHandler, extractEagGraphRequestFromPrompt } from "./eag/cli/index";
import type { EagGraphRequest, EagGraphCommandResult } from "./eag/cli/index";
import type {
  EagDynamicSuggester,
  EagDynamicSuggestion,
  EagCommandKind,
  EagClarificationOption,
  DynamicCommandDescriptor,
} from "./eag/dynamic/index";
// === 中断与后台任务导入（ADR-DI-001）===
// InterruptQueue / TaskRegistry / BackgroundTaskRunner 均为可选注入，
// 未注入时中断能力不可用，主流程零回归。详见 docs/dev/ADR-DI-001-*.md。
import type {
  InterruptQueue,
  TaskRegistry,
  BackgroundTaskRunner,
  BackgroundTask,
  TaskKind,
  TaskStatus,
  TaskListFilter,
  InjectedInstruction,
  InjectSource,
} from "./interrupts/index";
// InjectInterruptError 是值（错误类），需要值导入而非 type 导入
// 用于 createChatCompletionStream 抛出 + activateSession catch 块 instanceof 判定
import { InjectInterruptError } from "./interrupts/index";
// 上游 v0.3.1：多模态能力判定（图片消息是否启用）与 DeepSeek Files API 文件存储
import { supportsMultimodal, type MultimodalMode } from "./common/model-capabilities";
import {
  decodeDeepSeekImageDataUrl,
  DeepSeekFileStore,
  type DeepSeekFileReference,
  type DeepSeekFilesPolicy,
} from "./common/deepseek-files";

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
// DeepSeek V4 系列 compact 阈值固定 512K（模型支持 1M 上下文）
// 注：与上游 getDefaultAutoCompactWindow("deepseek-v4-*") = 1M/2 数值一致，两侧语义等价
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

/**
 * 获取 compact 阈值（token 数）
 *
 * 融合语义（fork + 上游 v0.3.1）：
 * 1. DeepSeek V4 系列固定 512K（fork 常量，与上游 getDefaultAutoCompactWindow 的 1M/2 数值一致）；
 * 2. 显式传入 contextWindow 时采用 fork 语义：contextWindow * 0.8（预留 20% 给 output + tool 结果），
 *    避免上下文窗口刚好满载时 API 返回 400 超限错误；
 * 3. 未传入 contextWindow 时采用上游语义：按模型推断默认 autoCompact 窗口的一半
 *    （DeepSeek V4 = 1M/2，其余模型 256K/2 = 128K）。
 *
 * @param model 模型名称（用于 DeepSeek V4 特殊处理）
 * @param contextWindow 模型上下文窗口大小（token 数），可选；未传时按模型默认值推断
 * @returns compact 阈值（超过此值时触发会话压缩）
 */
export function getCompactPromptTokenThreshold(model: string, contextWindow?: number): number {
  // DeepSeek V4 系列保留原阈值（512K，模型支持 1M 上下文）
  if (DEEPSEEK_V4_MODELS.has(model)) {
    return DEEPSEEK_V4_COMPACT_PROMPT_TOKEN_THRESHOLD;
  }
  // 显式传入 contextWindow：预留 20% 给 output + tool 结果，确保在 API 调用前 compact
  if (typeof contextWindow === "number" && contextWindow > 0) {
    return Math.floor(contextWindow * 0.8);
  }
  // 未传入 contextWindow：采用上游 v0.3.1 语义（按模型推断默认窗口的一半）
  return getDefaultAutoCompactWindow(model);
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

/**
 * 递归替换字符串值（上游 v0.3.1）：用于会话消息中源目录 → 目标目录的路径重写
 * （session fork/恢复到新目录时，把历史消息里的旧绝对路径批量替换为新路径）。
 *
 * @param value 任意 JSON 兼容值（字符串/数组/对象/其他）
 * @param search 待替换的子串（旧路径）
 * @param replacement 替换后的子串（新路径）
 * @returns 替换后的新值（不修改原值）
 */
function replaceStringValues(value: unknown, search: string, replacement: string): unknown {
  if (typeof value === "string") {
    return value.split(search).join(replacement);
  }
  if (Array.isArray(value)) {
    return value.map((item) => replaceStringValues(item, search, replacement));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, replaceStringValues(item, search, replacement)])
    );
  }
  return value;
}
// 注：上游在此处还定义了本地 isUsageRecord（判断普通对象），与 fork 侧已迁移到
// ./usage-tracker.ts 的同名函数冲突，此处统一采用 usage-tracker 导入版本，避免重复定义
function summarizeCompletionOptions(options?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!options) {
    return undefined;
  }
  return {
    ...options,
    signal: options.signal instanceof AbortSignal ? { aborted: options.signal.aborted } : options.signal,
  };
}

// Usage 相关函数（isUsageRecord/addUsageValue/accumulateUsage/usageWithRequestCount/
// accumulateUsagePerModel/getTotalTokens/toModelUsage）已迁移到 ./usage-tracker.ts
// 详见 docs/dev/review.md CRITICAL-1 模块 2
// 注：上游 v0.3.1 在此处内联定义了同名函数，两侧实现等价，统一采用 usage-tracker 模块版本

export type SessionStatus =
  | "failed"
  | "pending"
  | "processing"
  | "waiting_for_user"
  | "completed"
  | "interrupted"
  | "ask_permission"
  | "permission_denied";

// ModelUsage 类型已迁移到 ./usage-tracker.ts（通过 import + re-export 引入）
// 注：上游 v0.3.1 在此处内联定义了该类型，字段集与 usage-tracker 版本一致

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
  // 上游 v0.3.1：限流插件命中的工具信息（供 CLI 渲染限流提示）
  pluginRateLimitedTool?: PluginRateLimitedTool;
  // 上游 v0.3.1：会话 fork 来源（session fork/恢复到新目录时的溯源信息）
  forkedFrom?: {
    sessionId: string;
    messageId: string;
  };
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
  // 上游 v0.3.1：技能目录快照（技能列表变化时随消息持久化，供恢复会话后重建目录提示）
  skillCatalog?: Array<{ name: string; description: string }>;
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

// 上游 v0.3.1：多模态持久化图片（粘贴/拖拽图片在会话存储中的二进制表示）
type PersistedPromptImage = {
  buffer: Buffer;
  extension: ".jpg" | ".png" | ".webp";
};

export type SkillInfo = {
  name: string;
  path: string;
  description: string;
  isLoaded?: boolean;
  allowImplicitInvocation?: boolean;
};

/**
 * 会话管理器选项（fork + 上游 v0.3.1 融合）
 *
 * - fork 侧：createLLMClient 统一 LLM 工厂、EAG 系列可选注入、中断/后台任务注入、V2 上下文钩子；
 * - 上游侧：multimodal / filesApi* / contextWindow / autoCompactWindow 等新设置字段。
 */
export type SessionManagerOptions = {
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
    // 上游 v0.3.1：多模态开关与 Files API 配置
    multimodal?: MultimodalMode;
    filesApiEnabled?: boolean;
    filesApiTimeoutMs?: number;
    fileExpiresAfterSeconds?: number;
    fileRefreshMarginSeconds?: number;
    fileQuotaCleanupBatch?: number;
    maxRequestFilesBytes?: number;
    // 上游 v0.3.1：上下文窗口与自动 compact 窗口（token 数）
    contextWindow?: number;
    autoCompactWindow?: number;
    timeout?: number;
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
   * 未注入时 `/eag-design` 命令不可用，主对话循环行为完全不变（向后兼容）。
   * 注入后，在主对话循环检测到 `/eag-design` 命令时外挂调用 handleEagDesignCommand，
   * 路由到 DesignLoopOrchestrator.run() 执行 DESIGN Loop 闭环。
   *
   * 设计决策（对齐设计文档 §5.2 N-M-1 修复 + Karpathy Simplicity First）：
   * - 调用方负责在注入前完整装配 DesignLoopOrchestratorOptions
   * - session.ts 不负责构造 DesignLoopOrchestrator 实例（避免每次命令重复构造，且与
   *   codingOrchestrator / testingOrchestrator / devopsOrchestrator 同构）
   *
   * 不可变优先（§5.12.4 G-A6d）：构造后字段不可变，循环内不可被 LLM 修改。
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
   *   codingOrchestrator / testingOrchestrator 同构）
   *
   * 不可变优先（§5.12.4 G-A6d）：构造后字段不可变，循环内不可被 LLM 修改。
   */
  devopsOrchestrator?: DevOpsOrchestrator;
  /**
   * EAG-P5 Phase 5.3：无人值守编排器（可选注入，§4.1 / §5 CLI 命令规范）
   *
   * 未注入时 `/eag-autonomous` 命令不可用，主对话循环行为完全不变（向后兼容）。
   * 注入后，在主对话循环检测到 `/eag-autonomous` 命令时外挂调用 handleEagAutonomousCommand，
   * 路由到 AutonomousOrchestrator.run() 执行 4 阶段循环（plan → dev → verify → fix）。
   *
   * 设计决策（对齐 EAG-P4 批次 13 §5.2 N-M-1 修复 + Karpathy Simplicity First）：
   * - 调用方负责在注入前完整装配 AutonomousOrchestratorOptions（loopExecutor /
   *   runStateStore / notesMemory / guardChain / smartConfirmation 全部依赖）
   * - session.ts 不负责构造这些依赖（避免每次命令重复构造，且与
   *   codingOrchestrator / testingOrchestrator / devopsOrchestrator 同构）
   *
   * 不可变优先（§5.12.4 G-A6d）：构造后字段不可变，循环内不可被 LLM 修改。
   */
  autonomousOrchestrator?: AutonomousOrchestrator;
  /**
   * Loop-Graph 融合方案 Phase 5：图级编排器（可选注入，§12.2 / §14 Phase 5）
   *
   * 未注入时 `/eag-graph` 命令不可用，主对话循环行为完全不变（向后兼容）。
   * 注入后，在主对话循环检测到 `/eag-graph` 命令时外挂调用 handleEagGraphCommand，
   * 路由到 GraphLoopOrchestrator.run() 执行图遍历（DAG 拓扑 + 节点内 Loop）。
   *
   * 设计决策（对齐 §5.2 N-M-1 修复 + Karpathy Simplicity First）：
   * - 调用方负责在注入前完整装配 GraphLoopOrchestratorOptions（nodeExecutor /
   *   edgeResolver / graphScheduler / graphGuard / predicateRegistry / experienceStore 全部依赖）
   * - session.ts 不负责构造这些依赖（避免每次命令重复构造，且与
   *   autonomousOrchestrator / devopsOrchestrator 同构）
   *
   * 不可变优先（§5.12.4 G-A6d）：构造后字段不可变，循环内不可被 LLM 修改。
   */
  graphLoopOrchestratorOptions?: Readonly<GraphLoopOrchestratorOptions>;
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
  /**
   * EAG LLM 动态编排建议层（可选注入，2026-07-24 新增）
   *
   * 未注入时自然语言输入直接进入 LLM 主对话，行为完全不变（向后兼容，零回归）。
   * 注入后，当用户输入不是显式 /eag-xxx 命令时，调用 EagDynamicSuggester.suggest()
   * 判断任务粒度并给出建议：
   *   - direct_chat：进入 LLM 主对话
   *   - suggest_command / suggest_autonomous / suggest_graph：通过 assistant message 展示建议
   *   - ask_clarification：通过 AskUserQuestion 向用户展示选项，确认后再 refine 建议
   *
   * 第一阶段约束：只做建议，不自动执行任何命令，不自动生成 WorkGraph，不注册新工具。
   */
  eagDynamicSuggester?: EagDynamicSuggester;
  /**
   * 外部命令描述符注入（可选，2026-07-24 v1.4 新增）
   *
   * 由 CLI 层构造，包含 team/rules/slash 等非 EAG 命令的描述符。
   * session.ts 在构建建议层上下文时，将这些描述符与 EAG 命令描述符合并，
   * 使 LLM 能建议全部命令体系的命令。
   *
   * 设计原因：避免 core 包反向依赖 cli 包（cli 包依赖 core，不能反向）。
   * 未注入时，建议层只能看到 EAG 命令（向后兼容）。
   */
  dynamicCommandDescriptors?: ReadonlyArray<DynamicCommandDescriptor>;
  /**
   * 中断指令队列（可选注入，ADR-DI-001 §7.1 E1 扩展点）
   *
   * 未注入时 `/inject <指令>` 命令不可用，主循环行为完全不变（向后兼容，零回归）。
   * 注入后，主循环每次迭代头部（LLM 调用前）调用 `drain()` 消费队列中的指令，
   * 合成为 system 消息追加到会话消息流；同时 `createChatCompletionStream` 流式
   * chunk 之间检查队列非空，触发 `InjectInterruptError` 中断当前流，让主循环
   * 进入下一轮迭代消费指令。
   *
   * 设计约束（对齐 ADR-DI-001 §3.1 + §5.1）：
   * - 仅内存对象，不持久化（崩溃恢复由 TaskRegistry 维护任务级状态）
   * - FIFO 顺序保证指令按用户输入顺序被消费
   * - 容量上限保护（InterruptQueue.MAX_QUEUE_SIZE = 64）
   *
   * 不可变优先（§5.12.4 G-A6d）：构造后字段不可变，循环内不可被 LLM 修改。
   */
  interruptQueue?: InterruptQueue;
  /**
   * 后台任务注册表（可选注入，ADR-DI-001 §7.1 E1 扩展点）
   *
   * 未注入时 `/tasks` `/fg <id>` `/cancel <id>` `/pause` `/resume <id>`
   * 五个命令不可用，主对话循环行为完全不变（向后兼容，零回归）。
   * 注入后，所有前台 + 后台任务通过此注册表统一管理，提供：
   * - `register` / `unregister` / `get` / `list`：任务增删查改
   * - `setForeground` / `getForegroundId`：前台切换
   * - `notifyTaskStateChanged`：状态变更事件回调
   *
   * 并发上限保护：TaskRegistry.MAX_CONCURRENT_TASKS = 8（R-5 风险缓解）。
   *
   * 不可变优先（§5.12.4 G-A6d）：构造后字段不可变，循环内不可被 LLM 修改。
   */
  taskRegistry?: TaskRegistry;
  /**
   * 后台任务执行器（可选注入，ADR-DI-001 §7.1 E1 扩展点）
   *
   * 未注入时 `/bg <指令>` 命令不可用，主对话循环行为完全不变（向后兼容，零回归）。
   * 注入后，`/bg` 命令通过此执行器创建后台任务：
   * - 内部通过 sessionManagerFactory 创建独立 SessionManager 实例（D-1 决策）
   * - 独立 AbortController（取消不影响前台）
   * - 独立 InterruptQueue（支持对后台任务也 /inject）
   * - 异步启动，立即返回 { taskId, sessionId }
   *
   * 依赖关系（ADR-DI-001 §5.2.2）：
   * - 必须同时注入 taskRegistry（taskRegistry 未注入时本字段无效）
   * - 必须同时注入 sessionManagerFactory（由 BackgroundTaskRunner 内部持有）
   *
   * 不可变优先（§5.12.4 G-A6d）：构造后字段不可变，循环内不可被 LLM 修改。
   */
  backgroundRunner?: BackgroundTaskRunner;
  /**
   * 是否为主前台会话（可选，默认 true，ADR-DI-001 §7.1 E1 扩展点）
   *
   * - `true`（默认）：当前 SessionManager 作为主前台会话运行，用户输入直接作用于
   *   此会话；主循环每次迭代头部检查 interruptQueue（若注入）
   * - `false`：当前 SessionManager 作为后台子 agent 运行（由
   *   BackgroundTaskRunner.sessionManagerFactory 创建），不直接消费用户输入，
   *   主循环行为与前台一致但通过 task.cancel / task.inject 控制方向
   *
   * 设计约束：
   * - 默认值 `true` 保证现有调用方（不传此字段）行为零变化（向后兼容）
   * - 后台任务中创建的 SessionManager 必须显式传 `isForeground: false`
   * - 本字段主要供 UI 层判断是否启用 `/inject` `/bg` 等命令的快捷键
   */
  isForeground?: boolean;
  /**
   * V2 Session 上下文钩子（可选注入，§9.1）
   *
   * 未注入时 OpenAIMessageConverter 行为与 v1 完全一致（向后兼容，零回归）。
   * 注入后，buildMessages 在每轮 LLM 请求前同步调用 contextHook.preBuildContext，
   * 将缓存的上下文片段注入到首条 system message 末尾的 "## V2 Context" 区块。
   *
   * 配套使用：
   * - V2-P0a：DefaultSessionContextHook 提供基于 Map 的进程内存缓存与 TTL 过期
   * - V2-P1：DualLayerContextManager 在 turn 入口调用 refreshContextAsync 预计算上下文
   *
   * 不可变优先（§5.12.4 G-A6d）：构造后字段不可变，循环内不可被 LLM 修改。
   */
  contextHook?: SessionContextHook;
  // 上游 v0.3.1：sharp 图片库懒加载工厂（可选注入，ReadImage/UnderstandImage 图片工具依赖，
  // 未注入时图片工具按上游原语义降级处理）
  loadSharp?: SharpLoader;
  // 上游 v0.3.1：非交互模式标志（exec/headless 场景抑制交互式提示，默认 false）
  nonInteractive?: boolean;
};

export type LlmStreamProgress = {
  requestId: string;
  sessionId?: string;
  startedAt: string;
  estimatedTokens: number;
  formattedTokens: string;
  phase: "start" | "update" | "end";
};

/**
 * EAG 动态建议层待澄清状态
 *
 * 当 LLM 返回 ask_clarification 时，SessionManager 将问题与选项暂存，
 * 等待用户下一轮回复后解析答案并回注到 suggester 进行 refine。
 */
type EagClarificationPending = {
  /** 澄清问题文本 */
  readonly question: string;
  /** 选项清单 */
  readonly options: ReadonlyArray<EagClarificationOption>;
  /** 是否支持多选 */
  readonly multiSelect: boolean;
  /** 触发本轮澄清的原始用户目标 */
  readonly originalGoal: string;
  /** 当前澄清轮次（从 1 开始，最多 3 轮） */
  readonly round: number;
};

/** 最大澄清轮次，防止无限澄清循环 */
const MAX_EAG_CLARIFICATION_ROUNDS = 3;

export class SessionManager {
  private readonly projectRoot: string;
  private readonly createOpenAIClient: CreateOpenAIClient;
  // B1：统一 LLM 客户端工厂注入（可选，测试缝合点；未注入时走 resolveCurrentSettings + ProviderFactory）
  private readonly createLLMClientOverride?: CreateLLMClient;
  private readonly getResolvedSettings: () => {
    model: string;
    // 上游 v0.3.1：多模态开关与 Files API 配置
    multimodal?: MultimodalMode;
    filesApiEnabled?: boolean;
    filesApiTimeoutMs?: number;
    fileExpiresAfterSeconds?: number;
    fileRefreshMarginSeconds?: number;
    fileQuotaCleanupBatch?: number;
    maxRequestFilesBytes?: number;
    // 上游 v0.3.1：上下文窗口与自动 compact 窗口（token 数）
    contextWindow?: number;
    autoCompactWindow?: number;
    // fork 侧：LLM 请求超时（毫秒）
    timeout?: number;
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
  // 上游 v0.3.1：非交互模式标志（exec/headless 场景抑制交互式提示）
  private readonly nonInteractive: boolean;
  private activeSessionId: string | null = null;
  private activePromptController: AbortController | null = null;
  // SkillManager 实例（技能扫描/解析/去重/归一化，见 docs/dev/review.md CRITICAL-1 模块 3）
  private readonly skillManager: SkillManager;
  // FileHistoryCoordinator 实例（undo/file-history 域协调器，S4 首阶段拆分，
  // 抽取模式见 file-history-coordinator.ts 模块头注释，供后续域拆分复用）
  private readonly fileHistoryCoordinator: FileHistoryCoordinator;
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
  // EAG-P5 Phase 5.3 外挂字段（可选注入，未注入时 /eag-autonomous 命令不可用，§4.1 / §5 CLI 命令规范）
  // - autonomousOrchestrator：未注入时 /eag-autonomous 命令不可用
  //   调用方在 SessionManagerOptions.autonomousOrchestrator 中注入完整装配的 AutonomousOrchestrator 实例
  //   （loopExecutor / runStateStore / notesMemory / guardChain / smartConfirmation 全部依赖）
  private readonly autonomousOrchestrator?: AutonomousOrchestrator;
  // Loop-Graph 融合方案 Phase 5 外挂字段（可选注入，未注入时 /eag-graph 命令不可用，§12.2 / §14 Phase 5）
  // - graphLoopOrchestratorOptions：未注入时 /eag-graph 命令不可用
  //   调用方在 SessionManagerOptions.graphLoopOrchestratorOptions 中注入完整装配的 GraphLoopOrchestratorOptions
  //   （nodeExecutor / edgeResolver / graphScheduler / graphGuard / predicateRegistry / experienceStore 全部依赖）
  // TOP-1 修订：session.ts 不再持有 GraphLoopOrchestrator 实例，改为注入构造选项，
  // 由 EagGraphCommandHandler 内部通过 GraphLifecycleManager 统一初始化与执行。
  private readonly graphLoopOrchestratorOptions?: Readonly<GraphLoopOrchestratorOptions>;
  // EAG-P3 批次 11 S3：CLI 命令解析器（§5 S3 改进方案 D-S3-4）
  // - 默认 new EagCommandParser()，保证向后兼容（未注入时主循环行为不变）
  // - 负责判定 6 个 EAG 命令字符串并从 messageParams 提取预装配的请求对象
  // - 替代原 session.ts 中的 6 个 isEagXxxPrompt + 6 个 extractXxxRequest 私有方法
  private readonly eagCommandParser: EagCommandParser;
  // EAG LLM 动态编排建议层（2026-07-24 新增）
  // - 可选注入，未注入时自然语言输入直接进入 LLM 主对话（零回归）
  // - 负责在显式命令未命中时，根据用户目标给出全局命令建议或要求澄清
  private readonly eagDynamicSuggester?: EagDynamicSuggester;
  // 外部命令描述符（team/rules/slash，由 CLI 层注入）
  // - 与 EAG 命令描述符合并后供建议层使用
  // - 未注入时建议层只能看到 EAG 命令（向后兼容）
  private readonly dynamicCommandDescriptors?: ReadonlyArray<DynamicCommandDescriptor>;
  // ADR-DI-001 动态指令注入与后台子 Agent 外挂字段（可选注入，未注入时对应命令不可用）
  // - interruptQueue：未注入时 /inject 命令不可用，主循环行为完全不变（零回归）
  //   注入后主循环 LLM 调用前 drain，合成为 system 消息追加到会话消息流
  // - taskRegistry：未注入时 /tasks /fg /cancel /pause /resume 命令不可用
  //   注入后所有前台 + 后台任务通过此注册表统一管理
  // - backgroundRunner：未注入时 /bg 命令不可用
  //   注入后通过此执行器创建后台任务（独立 SessionManager + 独立 AbortController）
  // - isForeground：默认 true，标识当前 SessionManager 是否为主前台会话
  //   后台任务中创建的 SessionManager 设为 false（由 BackgroundTaskRunner 注入）
  private readonly interruptQueue?: InterruptQueue;
  private readonly taskRegistry?: TaskRegistry;
  private readonly backgroundRunner?: BackgroundTaskRunner;
  private readonly isForeground: boolean;
  // V2 Session 上下文钩子（可选注入，§9.1）
  // - 未注入时 messageConverter 行为与 v1 一致
  // - 注入后 buildMessages 同步调用 preBuildContext 注入上下文片段
  private readonly contextHook?: SessionContextHook;
  // EAG 动态建议层待澄清状态（内存级，key = sessionId）
  // - 当 LLM 返回 ask_clarification 时写入
  // - 用户下一轮回复命中时解析答案并回注 clarification，随后清除
  private readonly pendingEagClarifications = new Map<string, EagClarificationPending>();
  // 上游 v0.3.1：DeepSeek Files API 文件存储（图片上传/file_id 引用/配额清理）
  private readonly deepSeekFiles = new DeepSeekFileStore();

  constructor(options: SessionManagerOptions) {
    this.projectRoot = options.projectRoot;
    this.createOpenAIClient = options.createOpenAIClient;
    // B1：统一 LLM 工厂注入（未注入时走默认 resolveCurrentSettings + ProviderFactory 路由）
    this.createLLMClientOverride = options.createLLMClient;
    // 上游 v0.3.1：非交互模式标志赋值（exec/headless 场景）
    this.nonInteractive = options.nonInteractive === true;
    this.getResolvedSettings = options.getResolvedSettings;
    this.onAssistantMessage = options.onAssistantMessage;
    this.onSessionEntryUpdated = options.onSessionEntryUpdated;
    this.onLlmStreamProgress = options.onLlmStreamProgress;
    this.onMcpStatusChanged = options.onMcpStatusChanged;
    this.onProcessStdout = options.onProcessStdout;
    // 合并说明：ToolExecutor 第 4 参保持 fork 侧 createLLMClient 工厂（B1 统一 LLM 路由），
    // 第 5 参采纳上游 v0.3.1 的 loadSharp（sharp 图片库懒加载，ReadImage/UnderstandImage 依赖）
    this.toolExecutor = new ToolExecutor(
      this.projectRoot,
      this.createOpenAIClient,
      this.mcpManager,
      () => this.createLLMClient(),
      options.loadSharp
    );
    // V2 codemap 工具注入：将 codemap_query / impact_analysis / flow_trace / risk_scan
    // 4 个工具注册到 ToolExecutor，图谱不可用时降级返回空结果（NFR-4 零回归）
    registerCodemapTools(this.toolExecutor, new DefaultSymbolGraphAdapter());
    // ADR-DI-001 中断管理 LLM 工具注入（§7.3）：
    // 将 background_task / list_tasks / cancel_task / inject_message 4 个工具注册到 ToolExecutor。
    //
    // 注意：this 此时可能还未具备 InterruptibleSessionManager 的全部方法（taskRegistry /
    // backgroundRunner / 7 个扩展方法由另一个子代理通过可选注入实现）。
    // registerInterruptTools 内部 handler 延迟绑定——调用时才检查方法是否存在，
    // 未注入时返回 "feature unavailable" 错误（与 codemap 工具降级语义一致）。
    // 因此此处安全注册，不影响现有行为（NFR-4 零回归）。
    registerInterruptTools(this.toolExecutor, this as unknown as InterruptibleSessionManager);
    this.mcpManager.prepare(this.getResolvedSettings().mcpServers);
    // SkillManager 初始化（最小依赖注入：projectRoot / getResolvedSettings / listSessionMessages）
    // listSessionMessages 绑定到 this，确保 SkillManager 能访问当前会话消息
    this.skillManager = new SkillManager({
      projectRoot: this.projectRoot,
      getResolvedSettings: () => this.getResolvedSettings(),
      listSessionMessages: (sessionId: string) => this.listSessionMessages(sessionId),
    });
    // FileHistoryCoordinator 初始化（最小依赖注入：projectRoot / getProjectStorage /
    // listSessionMessages / saveSessionMessages，对齐 SkillManager 回调注入模式）。
    // getProjectStorage 返回 projectDir（file-history git 目录在其下解析）；
    // 消息读写回调绑定 this，hash 回写链路（updateLatestUserCheckpointHash）依赖二者。
    this.fileHistoryCoordinator = new FileHistoryCoordinator({
      projectRoot: this.projectRoot,
      getProjectStorage: () => this.getProjectStorage().projectDir,
      listSessionMessages: (sessionId: string) => this.listSessionMessages(sessionId),
      saveSessionMessages: (sessionId: string, messages: SessionMessage[]) =>
        this.saveSessionMessages(sessionId, messages),
    });
    // V2 上下文钩子注入：构造时传入 OpenAIMessageConverter
    // 未注入 contextHook 时行为与 v1 完全一致（向后兼容）
    this.contextHook = options.contextHook;
    this.messageConverter = new OpenAIMessageConverter({
      renderInitPrompt: () => this.renderInitCommandPrompt(),
      contextHook: this.contextHook,
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
    // EAG-P5 Phase 5.3 外挂字段赋值（可选注入，未注入时 /eag-autonomous 命令不可用）
    // 调用方负责在注入前完整装配 AutonomousOrchestratorOptions（loopExecutor / runStateStore /
    // notesMemory / guardChain / smartConfirmation），session.ts 不负责构造依赖
    this.autonomousOrchestrator = options.autonomousOrchestrator;
    // Loop-Graph 融合方案 Phase 5 外挂字段赋值（可选注入，未注入时 /eag-graph 命令不可用）
    // 调用方负责在注入前完整装配 GraphLoopOrchestratorOptions（nodeExecutor / edgeResolver /
    // graphScheduler / graphGuard / predicateRegistry / experienceStore），session.ts 不负责构造依赖
    // TOP-1 修订：保存 options，由 EagGraphCommandHandler 内部创建 GraphLifecycleManager 并初始化编排器
    this.graphLoopOrchestratorOptions = options.graphLoopOrchestratorOptions;
    // EAG-P3 批次 11 S3：CLI 命令解析器赋值（默认 new EagCommandParser()，向后兼容）
    this.eagCommandParser = options.eagCommandParser ?? new EagCommandParser();
    // EAG LLM 动态编排建议层赋值（可选注入，未注入时保持 undefined）
    this.eagDynamicSuggester = options.eagDynamicSuggester;
    // 外部命令描述符赋值（可选注入，未注入时保持 undefined，建议层只能看到 EAG 命令）
    this.dynamicCommandDescriptors = options.dynamicCommandDescriptors;
    // ADR-DI-001 动态指令注入与后台子 Agent 外挂字段赋值（可选注入，未注入时对应命令不可用）
    // - interruptQueue：未注入时主循环不检查队列，行为零变化（向后兼容）
    // - taskRegistry：未注入时 /tasks /fg /cancel /pause /resume 命令不可用
    // - backgroundRunner：未注入时 /bg 命令不可用
    // - isForeground：默认 true，保证现有调用方行为零变化（向后兼容）
    //   后台任务中创建的 SessionManager 由 BackgroundTaskRunner 显式传 false
    this.interruptQueue = options.interruptQueue;
    this.taskRegistry = options.taskRegistry;
    this.backgroundRunner = options.backgroundRunner;
    this.isForeground = options.isForeground ?? true;
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
    model: string,
    // 上游 v0.3.1：多模态模式（可选，默认 "default" 保持 v1 行为，向后兼容）
    multimodal?: MultimodalMode
  ): ChatCompletionMessageParam[] {
    return this.messageConverter.buildMessages(messages, thinkingEnabled, model, multimodal);
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

  // Token 估算与格式化（已迁移到 ./stream-aggregator.ts，见 docs/dev/review.md CRITICAL-1 模块 1）
  // 注：上游 v0.3.1 在此处内联了同语义实现（CJK 0.6/其他 0.3 加权、k 格式化），两侧等价
  private estimateStreamTokens(text: string): number {
    return estimateStreamTokensImpl(text);
  }

  private formatEstimatedTokens(tokens: number): string {
    return formatEstimatedTokensImpl(tokens);
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

  // 中断类错误判定与中断抛出（已迁移到 ./stream-aggregator.ts，见 CRITICAL-1 模块 1）
  // 注：上游 v0.3.1 内联实现（AbortError/APIUserAbortError 判定）与模块版语义等价
  private isAbortLikeError(error: unknown): boolean {
    return isAbortLikeErrorImpl(error);
  }

  private throwIfAborted(signal?: AbortSignal | null): void {
    throwIfAbortedImpl(signal);
  }

  /**
   * 解析 DeepSeek Files API 设置（上游 v0.3.1 新增）
   *
   * 从 resolved settings 中读取 filesApiEnabled 与各文件生命周期参数，
   * 未配置时回退到 settings.ts 导出的默认值（超时 60s / 过期 7 天 /
   * 刷新余量 1h / 配额清理批量 100 / 单请求上限 128MB）。
   *
   * @returns enabled 是否启用 Files API、maxRequestFilesBytes 单请求字节上限、policy 上传策略
   */
  private getDeepSeekFilesSettings(): {
    enabled: boolean;
    maxRequestFilesBytes: number;
    policy: DeepSeekFilesPolicy;
  } {
    const settings = this.getResolvedSettings();
    return {
      enabled: settings.filesApiEnabled === true,
      maxRequestFilesBytes: settings.maxRequestFilesBytes ?? DEFAULT_MAX_REQUEST_FILES_BYTES,
      policy: {
        timeoutMs: settings.filesApiTimeoutMs ?? DEFAULT_FILES_API_TIMEOUT_MS,
        expiresAfterSeconds: settings.fileExpiresAfterSeconds ?? DEFAULT_FILE_EXPIRES_AFTER_SECONDS,
        refreshMarginSeconds: settings.fileRefreshMarginSeconds ?? DEFAULT_FILE_REFRESH_MARGIN_SECONDS,
        quotaCleanupBatch: settings.fileQuotaCleanupBatch ?? DEFAULT_FILE_QUOTA_CLEANUP_BATCH,
      },
    };
  }

  /**
   * 构建带 DeepSeek Files API 文件引用的消息列表（上游 v0.3.1 新增）
   *
   * 多模态启用时，把消息中的 data URL 图片抽取出来上传到 DeepSeek Files API，
   * 并将 image_url 占位替换为 { type: "file", file_id } 引用，
   * 避免大图直接内联到请求体（受 maxRequestFilesBytes 上限保护）。
   *
   * @param messages 会话消息列表
   * @param thinkingEnabled 是否启用思考模式
   * @param model 模型名称
   * @param apiKey DeepSeek API Key（上传文件用）
   * @param signal 中断信号
   * @returns 转换后的消息列表与上传得到的文件引用列表
   */
  private async buildMessagesWithDeepSeekFiles(
    messages: SessionMessage[],
    thinkingEnabled: boolean,
    model: string,
    apiKey: string,
    signal: AbortSignal
  ): Promise<{ messages: ChatCompletionMessageParam[]; references: DeepSeekFileReference[] }> {
    const settings = this.getDeepSeekFilesSettings();
    const converted = this.messageConverter.buildMessages(messages, thinkingEnabled, model, "on");
    const images: Array<{
      messageIndex: number;
      contentIndex: number;
      image: ReturnType<typeof decodeDeepSeekImageDataUrl>;
    }> = [];
    let totalBytes = 0;

    // 遍历转换后的消息，收集全部 image_url 内容块并校验总字节上限
    for (let messageIndex = 0; messageIndex < converted.length; messageIndex += 1) {
      const content = (converted[messageIndex] as { content?: unknown }).content;
      if (!Array.isArray(content)) {
        continue;
      }
      for (let contentIndex = 0; contentIndex < content.length; contentIndex += 1) {
        const part = content[contentIndex] as { type?: unknown; image_url?: { url?: unknown } };
        if (part.type !== "image_url" || typeof part.image_url?.url !== "string") {
          continue;
        }
        const image = decodeDeepSeekImageDataUrl(part.image_url.url, images.length);
        totalBytes += image.buffer.byteLength;
        if (totalBytes > settings.maxRequestFilesBytes) {
          throw new Error(
            `Images in this request exceed the configured ${settings.maxRequestFilesBytes}-byte Files API limit.`
          );
        }
        images.push({ messageIndex, contentIndex, image });
      }
    }

    // 并行上传全部图片，拿到 file_id 引用
    const references = await Promise.all(
      images.map(({ image }) => this.deepSeekFiles.ensureUploaded(image, apiKey, settings.policy, signal))
    );
    // 浅拷贝含数组 content 的消息，避免原地修改缓存数据
    const result = converted.map((message) => {
      const content = (message as { content?: unknown }).content;
      return Array.isArray(content) ? ({ ...message, content: [...content] } as ChatCompletionMessageParam) : message;
    });
    // 将 image_url 占位替换为 file 引用
    for (let index = 0; index < images.length; index += 1) {
      const image = images[index];
      const content = (result[image.messageIndex] as { content: unknown[] }).content;
      content[image.contentIndex] = { type: "file", file_id: references[index].fileId };
    }
    return { messages: result, references };
  }

  /**
   * 判定错误是否为 DeepSeek Files API 拒绝文件引用错误（上游 v0.3.1 新增）
   *
   * 仅识别 HTTP 400 且错误消息同时命中「file 相关词」与「缺失/无效描述」的场景，
   * 用于上传引用失效时的降级重试（如文件已过期/删除/不属于当前账号）。
   *
   * @param error 捕获到的错误对象
   * @returns 是否为可降级的文件引用被拒错误
   */
  private isRejectedDeepSeekFile(error: unknown): boolean {
    const status = (error as { status?: unknown } | null)?.status;
    if (status !== 400) {
      return false;
    }
    const detail = error instanceof Error ? error.message : String(error);
    const file = /\bfile(?:[_ -]?(?:id|api|not[_ -]?found|deleted|expired))?/i.test(detail);
    const missing =
      /(?:expired|not[_ -]?found|deleted|do(?:es)? not exist|not created under (?:this|your) account)/i.test(detail);
    const invalidId = /(?:invalid.{0,20}file[_ -]?(?:id|api)|file[_ -]?(?:id|api).{0,20}invalid)/i.test(detail);
    return file && (missing || invalidId);
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

    // 提取流式安全控制参数（非 OpenAI SDK 标准字段，需在传给 SDK 前过滤）
    const rawSignal =
      options && typeof options.signal === "object" && options.signal instanceof AbortSignal
        ? options.signal
        : undefined;
    const maxReasoningLength =
      options && typeof (options as Record<string, unknown>).maxReasoningLength === "number"
        ? ((options as Record<string, unknown>).maxReasoningLength as number)
        : undefined;
    const streamTimeoutMs =
      options && typeof (options as Record<string, unknown>).streamTimeoutMs === "number"
        ? ((options as Record<string, unknown>).streamTimeoutMs as number)
        : undefined;

    // 构造统一的安全控制器：聚合外部 signal、超时 signal 与内部主动中断。
    // 通过 AbortController 管理，确保需要主动中断（如 reasoning 超长）时可调用 abort()。
    const safetyController = new AbortController();
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const propagateAbort = () => {
      safetyController.abort();
    };
    if (rawSignal) {
      if (rawSignal.aborted) {
        safetyController.abort();
      } else {
        rawSignal.addEventListener("abort", propagateAbort, { once: true });
      }
    }
    if (streamTimeoutMs && streamTimeoutMs > 0) {
      timeoutHandle = setTimeout(() => safetyController.abort(), streamTimeoutMs);
    }

    // 构造 SDK 选项：只保留 SDK 认识的 signal
    const sdkOptions: Record<string, unknown> = { signal: safetyController.signal };

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
      )(
        // fork 侧：传 sdkOptions（仅含安全控制器的 signal），非 SDK 标准字段已在上方过滤
        streamRequest,
        sdkOptions
      );
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
        error: getLlmErrorDetails(error),
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
        // E3 扩展点（ADR-DI-001 §5.1.3）：流式 chunk 之间检查中断队列
        //
        // 设计约束（Karpathy Surgical Changes）：
        // - 仅在 interruptQueue 注入时生效，未注入时流式行为完全不变（零回归）
        // - 每接收一个 chunk 检查一次队列非空
        // - 队列非空时抛 InjectInterruptError，由 activateSession catch 块识别
        // - catch 块不设置 status="failed"，而是 continue 进入下一轮迭代
        // - 下一轮迭代头部（E2 扩展点）drain 队列，合成 system 消息
        //
        // 不破坏现有 stream 错误处理：
        // - InjectInterruptError 走 catch 块 finally 路径，emitLlmStreamProgress 仍正常触发
        // - logChatCompletionDebug / logApiError 不会被 InjectInterruptError 触发（异常路径由
        //   activateSession catch 块单独识别，本 catch 块重新 throw 让上层处理）
        // - 不调用 controller.abort()（避免与 cancel/pause 信号混淆）
        if (this.interruptQueue && this.interruptQueue.size > 0) {
          // 抛出 InjectInterruptError，由 activateSession catch 块识别并 continue 进入下一轮迭代
          // 注：pendingCount 字段携带当前队列长度，便于日志与 UI 展示
          throw new InjectInterruptError(this.interruptQueue.size);
        }
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
            // Skill matching 等短输出场景防护：reasoning 模型（如 Qwen3）可能在 thinking
            // 过程中陷入循环，产生超长 reasoning 内容。超过阈值时立即 abort 并抛错，
            // 由上层 catch 安全降级（如 identifyMatchingSkillNames 返回空数组）。
            if (maxReasoningLength && reasoningContent.length > maxReasoningLength) {
              safetyController.abort();
              throw new Error(`reasoning content exceeded safety limit (${maxReasoningLength} chars)`);
            }
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
      // E3 扩展点（ADR-DI-001 §5.1.3）：InjectInterruptError 是流控制信号，不是错误
      //
      // 设计约束：
      // - 不记录 logApiError（避免污染 API 错误日志，这是用户主动注入指令的正常流程）
      // - 不记录 logChatCompletionDebug（流被中断是预期行为，非调试关注点）
      // - 直接 re-throw，由 activateSession 主循环 catch 块识别并 continue 进入下一轮迭代
      // - finally 块的 emitLlmStreamProgress("end") 仍正常触发（保证 UI 流式进度闭环）
      if (error instanceof InjectInterruptError) {
        throw error;
      }
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
        error: getLlmErrorDetails(error),
        request: streamRequest,
      });
      throw error;
    } finally {
      // fork 侧：清理超时定时器与外部 signal 监听器，避免泄漏
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      if (rawSignal) {
        rawSignal.removeEventListener("abort", propagateAbort);
      }
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

    // 前置 abort 守卫（对齐 OpenAI 通路 throwIfAborted 语义）：
    // 必须先于 progress start 发出，否则已中止信号会留下无 end 的孤对 progress
    this.throwIfAborted(request.signal);

    this.emitLlmStreamProgress(requestId, startedAt, estimatedTokens, "start", sessionId);

    // 提取流式安全控制参数（非 LLMClient 标准字段，传给 provider 前过滤）
    const rawSignal: AbortSignal | null | undefined =
      options && typeof options.signal === "object" && options.signal instanceof AbortSignal
        ? options.signal
        : request.signal;
    const maxReasoningLength: number | undefined =
      options && typeof options.maxReasoningLength === "number" ? options.maxReasoningLength : undefined;
    const streamTimeoutMs: number | undefined =
      options && typeof options.streamTimeoutMs === "number" ? options.streamTimeoutMs : undefined;

    // 构造统一的安全控制器：聚合外部 signal、超时 signal 与内部主动中断。
    // 通过 AbortController 管理，确保需要主动中断（如 reasoning 超长）时可调用 abort()。
    const safetyController = new AbortController();
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const propagateAbort = () => {
      safetyController.abort();
    };
    if (rawSignal) {
      if (rawSignal.aborted) {
        safetyController.abort();
      } else {
        rawSignal.addEventListener("abort", propagateAbort, { once: true });
      }
    }
    if (streamTimeoutMs && streamTimeoutMs > 0) {
      timeoutHandle = setTimeout(() => safetyController.abort(), streamTimeoutMs);
    }

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
        signal: safetyController.signal,
      })) {
        // E3 扩展点（ADR-DI-001 §5.1.3）：流式事件之间检查中断队列
        //
        // 与 OpenAI 通路（createChatCompletionStream）完全对等：
        // - 仅在 interruptQueue 注入时生效，未注入时流式行为完全不变（零回归）
        // - 每接收一个事件检查一次队列非空
        // - 队列非空时抛 InjectInterruptError，由 activateSession catch 块识别并 continue
        // - 不调用 controller.abort()（避免与 cancel/pause 信号混淆）
        if (this.interruptQueue && this.interruptQueue.size > 0) {
          // 抛出 InjectInterruptError，由 activateSession catch 块识别并 continue 进入下一轮迭代
          throw new InjectInterruptError(this.interruptQueue.size);
        }
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
            // 主对话 reasoning 超长防护：与 OpenAI 通路对齐，超过阈值时立即 abort 并抛错，
            // 由 activateSession catch 块识别后安全降级为 failed 状态，避免用户无响应等待。
            if (maxReasoningLength && reasoningContent.length > maxReasoningLength) {
              safetyController.abort();
              throw new Error(`reasoning content exceeded safety limit (${maxReasoningLength} chars)`);
            }
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
      // E3 扩展点（ADR-DI-001 §5.1.3）：InjectInterruptError 是流控制信号，不是错误
      //
      // 与 OpenAI 通路（createChatCompletionStream）catch 块完全对等：
      // - 不记录 logApiError（避免污染 API 错误日志，这是用户主动注入指令的正常流程）
      // - 不记录 logChatCompletionDebug（流被中断是预期行为，非调试关注点）
      // - 直接 re-throw，由 activateSession 主循环 catch 块识别并 continue 进入下一轮迭代
      // - finally 块的 emitLlmStreamProgress("end") 仍正常触发（保证 UI 流式进度闭环）
      if (error instanceof InjectInterruptError) {
        throw error;
      }
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
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      if (rawSignal) {
        rawSignal.removeEventListener("abort", propagateAbort);
      }
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
      // 合并说明：保留 fork 侧实现——相比上游增加了三重防护：
      // 1) provider 路由（anthropic 走 createMessage，openai 走 createChatCompletionStream）
      // 2) max_tokens 限制 + 显式禁用 thinking（避免 Qwen3/DeepSeek-R1 循环 reasoning）
      // 3) maxReasoningLength/streamTimeoutMs 流式安全参数
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
        // Skill matching 是短输出分类任务：禁用 thinking/reasoning，限制最大 token，
        // 并设置流式超时与 reasoning 长度上限，防止 reasoning 模型（如 Qwen3）陷入循环。
        const skillMatchingMaxTokens = 1024;
        const skillMatchingMaxReasoningLength = 4096;
        const skillMatchingStreamTimeoutMs = 15000;
        const response = await this.createChatCompletionStream(
          client,
          {
            model,
            temperature: 0.1,
            max_tokens: skillMatchingMaxTokens,
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: userPrompt },
            ],
            response_format: { type: "json_object" },
            // 显式禁用 thinking/reasoning，避免 Qwen3 / DeepSeek-R1 等模型在 skill
            // 选择阶段产生冗长且可能循环的 reasoning 内容。
            ...buildThinkingRequestOptions(false, baseURL, "max", model),
          },
          {
            ...(options?.signal ? { signal: options.signal } : {}),
            maxReasoningLength: skillMatchingMaxReasoningLength,
            streamTimeoutMs: skillMatchingStreamTimeoutMs,
          },
          options?.sessionId,
          {
            enabled: debugLogEnabled,
            location: "SessionManager.identifyMatchingSkillNames",
            baseURL,
            params: {
              purpose: "skill-matching",
              temperature: 0.1,
              max_tokens: skillMatchingMaxTokens,
              maxReasoningLength: skillMatchingMaxReasoningLength,
              streamTimeoutMs: skillMatchingStreamTimeoutMs,
            },
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

  // 技能扫描根目录/技能列表/路径解析/提示词构建等（已迁移到 ./skill-manager.ts，
  // 见 docs/dev/review.md CRITICAL-1 模块 3；上游 v0.3.1 内联实现与 SkillManager 语义一致）
  private getSkillScanRoots(): Array<{ root: string; displayRoot: string }> {
    return this.skillManager.getSkillScanRoots();
  }

  private getBundledSkillsRoot(): string {
    return this.skillManager.getBundledSkillsRoot();
  }

  async listSkills(sessionId?: string): Promise<SkillInfo[]> {
    return this.skillManager.listSkills(sessionId);
  }

  private resolveSkillPath(skillPath: string): string {
    return this.skillManager.resolveSkillPath(skillPath);
  }

  private buildSkillPrompt(skill: SkillInfo): string {
    return this.skillManager.buildSkillPrompt(skill);
  }

  private readSkillInfo(skillPath: string, displayPath: string, fallbackName: string): SkillInfo {
    return this.skillManager.readSkillInfo(skillPath, displayPath, fallbackName);
  }

  private getSkillKey(skill: Pick<SkillInfo, "path">): string {
    return this.skillManager.getSkillKey(skill);
  }

  private getSkillKeyByName(name: string): string {
    return this.skillManager.getSkillKeyByName(name);
  }

  private getLoadedSkillKeys(sessionId: string): Set<string> {
    return this.skillManager.getLoadedSkillKeys(sessionId);
  }

  private dedupeSkills(skills?: SkillInfo[]): SkillInfo[] | undefined {
    return this.skillManager.dedupeSkills(skills);
  }

  private async normalizeSkills(skills?: SkillInfo[], sessionId?: string): Promise<SkillInfo[] | undefined> {
    return this.skillManager.normalizeSkills(skills, sessionId);
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

  // === 上游 v0.3.1：技能目录（skillCatalog）辅助方法 ===
  // 随 MessageMeta.skillCatalog 字段一并采纳：会话恢复后可重建技能目录提示，
  // 且技能列表变化时仅在目录内容变化时追加新的 system 消息。

  /**
   * 从会话历史中提取最近一次记录的技能目录快照（system 消息 meta.skillCatalog）。
   *
   * @param sessionId 会话 ID
   * @returns 去重后的技能目录条目（name + description）
   */
  private listPreloadedSkillCatalog(sessionId: string): Array<{ name: string; description: string }> {
    const entries = new Map<string, { name: string; description: string }>();
    for (const message of this.listSessionMessages(sessionId)) {
      if (message.role !== "system") {
        continue;
      }
      const catalog = message.meta?.skillCatalog;
      if (!Array.isArray(catalog)) {
        continue;
      }
      for (const entry of catalog) {
        if (!entry || typeof entry.name !== "string" || !entry.name || entries.has(entry.name)) {
          continue;
        }
        entries.set(entry.name, {
          name: entry.name,
          description: typeof entry.description === "string" ? entry.description : "",
        });
      }
    }
    return Array.from(entries.values());
  }

  /**
   * 合并两个技能目录快照：以 previous 为基，追加 next 中未出现过的条目（按 name 去重）。
   *
   * @param previous 既有目录快照
   * @param next 新目录快照
   * @returns 合并后的目录快照
   */
  private mergeSkillCatalog(
    previous: Array<{ name: string; description: string }>,
    next: Array<{ name: string; description: string }>
  ): Array<{ name: string; description: string }> {
    const merged = [...previous];
    const seen = new Set(previous.map((entry) => entry.name));
    for (const entry of next) {
      if (seen.has(entry.name)) {
        continue;
      }
      seen.add(entry.name);
      merged.push(entry);
    }
    return merged;
  }

  /**
   * 追加技能目录 system 消息（内容与最近一条目录消息相同时跳过，避免重复刷屏）。
   *
   * @param sessionId 会话 ID
   * @param skills 技能目录条目列表
   */
  private appendSkillCatalogMessage(sessionId: string, skills: Array<{ name: string; description: string }>): void {
    if (skills.length === 0) {
      return;
    }
    const content = buildSkillCatalogPrompt(skills);
    const lastCatalogMessage = [...this.listSessionMessages(sessionId)]
      .reverse()
      .find((message) => message.role === "system" && Array.isArray(message.meta?.skillCatalog));
    if (lastCatalogMessage?.content === content) {
      return;
    }
    const message = this.buildSystemMessage(sessionId, content, null, false, { skillCatalog: skills });
    this.appendSessionMessage(sessionId, message);
  }

  /**
   * 按名称加载技能（上游 v0.3.1：供 LLM skill 工具调用）。
   *
   * @param sessionId 会话 ID
   * @param skillName 技能名称
   * @returns 工具执行结果（未找到/已加载/返回技能提示词三种情形）
   */
  async loadSkillByName(sessionId: string, skillName: string): Promise<ToolExecutionResult> {
    const skills = await this.listSkills(sessionId);
    const skill = skills.find((candidate) => candidate.name === skillName);
    if (!skill) {
      return {
        ok: false,
        name: "skill",
        error: `Unknown skill: ${skillName}. Check the available skills catalog for exact skill names.`,
      };
    }
    if (skill.isLoaded) {
      return {
        ok: true,
        name: "skill",
        output: `Skill already loaded: ${skill.name}.`,
      };
    }
    return {
      ok: true,
      name: "skill",
      output: this.buildSkillPrompt(skill),
      metadata: { skill: { ...skill, isLoaded: true } },
    };
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
      // V2 上下文缓存刷新：
      // createSession / replySession 会构建 system message 并调用 buildMessages；
      // 只有提前刷新，preBuildContext 才能在该轮首次 buildMessages 时命中上下文片段，
      // 否则 V2 上下文会延迟一整轮才生效。
      // - 已有 activeSessionId 时，在 turn 入口先刷新旧会话缓存（覆盖 replySession 场景）；
      // - 新会话无 activeSessionId 时，由 createSession 在生成 sessionId 后刷新（覆盖 T1）。
      // 刷新结果写入进程内存缓存，preBuildContext 在 buildMessages 热路径上同步读取，
      // 保证 buildMessages 同步签名不变。未注入 contextHook 或 V2 未启用时为空操作。
      // 注意：每 turn 仅刷新一次目标会话，LLM 流式循环内禁止重复调用。
      // 上下文刷新失败属于辅助能力降级，不应阻塞主对话流程，因此单独捕获并静默 swallow。
      if (this.activeSessionId) {
        try {
          await this.contextHook?.refreshContextAsync(this.activeSessionId);
        } catch {
          // 降级 swallow：V2 上下文预计算失败时保持主对话继续，保证零回归。
        }
      }

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
    // fork 侧：文件历史协调器初始化会话分支（coordinator 与上游内联方法操作同一
    // <projectDir>/file-history/.git 仓库，此处用 coordinator 版本避免重复初始化）
    this.fileHistoryCoordinator.ensureFileHistorySession(sessionId);

    // V2 上下文缓存刷新（新会话场景）：
    // 在 buildSystemMessage / buildMessages 之前刷新，确保首条 system message 能命中 preBuildContext 缓存。
    // 失败降级 swallow，避免阻塞主对话流程。
    if (this.contextHook?.refreshContextAsync) {
      try {
        await this.contextHook.refreshContextAsync(sessionId);
      } catch {
        // 降级 swallow：V2 上下文预计算失败时保持主对话继续，保证零回归。
      }
    }

    // 上游 v0.3.1：多模态图片持久化（preparePromptImages 把 data URL 图片落盘为
    // PersistedPromptImage 并替换 userPrompt 中的图片引用）；摘要在图片处理前捕获，
    // 保证含图提示词的会话摘要仍取自原始文本
    const originalSummary = userPrompt.text ? userPrompt.text.slice(0, 100) : "[Image Prompt]";
    userPrompt = this.preparePromptImages(sessionId, userPrompt);
    const now = new Date().toISOString();
    const index = this.loadSessionsIndex();
    const entry: SessionEntry = {
      id: sessionId,
      // 上游 v0.3.1：使用图片处理前捕获的原始摘要
      summary: originalSummary,
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

    // fork 侧：默认技能提示词（getDefaultSkillPrompt，含 enabledSkills 过滤）
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

    // fork 侧：用户提示检查点经 coordinator 记录（与上游 this.recordUserPromptCheckpoint
    // 语义一致，统一走 coordinator 保持 fork 既有调用链）
    this.fileHistoryCoordinator.recordUserPromptCheckpoint(sessionId);
    const userMessage = this.buildUserMessage(sessionId, userPrompt);
    this.appendSessionMessage(sessionId, userMessage);

    // 上游 v0.3.1：记录本轮匹配到的技能，供 skillCatalog 快照合并使用。
    // 采纳上游语义：匹配到的技能仅记入技能目录快照（LLM 经 skill 工具按需加载），
    // 不再自动注入技能消息——fork 旧的"匹配即注入"链路与目录快照设计冲突，
    // 会导致同一技能既注入全文又出现在目录中，浪费上下文且违背 0.3.1 的按需加载设计
    let matchedSkills: SkillInfo[] = [];
    if (userPrompt.text) {
      const skills = await this.listSkills();
      const skillNames = await this.identifyMatchingSkillNames(skills, userPrompt.text, { signal });
      this.throwIfAborted(signal);
      const skillSet = new Set(skillNames);
      matchedSkills = skills.filter((skill) => skillSet.has(skill.name));
    }
    userPrompt.skills = await this.normalizeSkills(userPrompt.skills);
    this.throwIfAborted(signal);

    this.appendSkillMessages(sessionId, userPrompt.skills);
    // 上游 v0.3.1：追加技能目录快照消息（合并历史目录与本轮匹配技能，内容变化才追加）
    this.appendSkillCatalogMessage(
      sessionId,
      this.mergeSkillCatalog(
        this.listPreloadedSkillCatalog(sessionId),
        matchedSkills.map((skill) => ({ name: skill.name, description: skill.description }))
      )
    );

    this.activeSessionId = sessionId;
    await this.activateSession(sessionId, controller);
    return sessionId;
  }

  async replySession(sessionId: string, userPrompt: UserPromptContent, controller?: AbortController): Promise<void> {
    const signal = controller?.signal;
    this.throwIfAborted(signal);
    // 上游 v0.3.1：会话不存在时兜底创建新会话；回复路径同样需要图片持久化
    // （preparePromptImages 把 data URL 图片落盘并替换 userPrompt 中的图片引用）
    if (!this.getSession(sessionId)) {
      await this.createSession(userPrompt, controller);
      return;
    }
    userPrompt = this.preparePromptImages(sessionId, userPrompt);
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

    // fork 侧：会话条目更新失败（竞态下被清理）时兜底创建新会话，保持 fork 既有行为
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
    // 合并冲突修复说明：此处原为错误拼接的重复 checkpoint 块（if 语句缺失方法体导致
    // 大括号不平衡、eagCommand 声明丢失），已按 fork 版 replySession 顺序重建：
    // EAG 命令分发 → 动态建议层 → 规则学习 Hook → reportNewPrompt → 检查点 → 用户消息
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
          // EAG-P5 Phase 5.3 TASK-P5-3.1-006：/eag-autonomous 命令分发到 handleEagAutonomousCommand
          // payload 类型为 EagAutonomousRequest | null，由 EagCommandParser.parse() 通过
          // 前缀匹配识别后从 userPrompt.messageParams.autonomousRunRequest 提取（D-S3-7 注入模式）
          // 或从命令字符串内联参数解析（extractEagAutonomousRequestFromPrompt）
          await this.handleEagAutonomousCommand(sessionId, userPrompt, eagCommand.payload, controller);
          return;
        case "eag-autonomous-status":
          // EAG-P5 v1.1 新增（设计文档 §3.6）：/eag-autonomous-status <run-id> 命令分发
          // payload 类型为 EagAutonomousStatusRequest | null，由 EagCommandParser.parse() 通过
          // 前缀匹配（优先于 /eag-autonomous）识别后从命令字符串解析 runId
          await this.handleEagAutonomousStatusCommand(sessionId, userPrompt, eagCommand.payload, controller);
          return;
        case "eag-autonomous-stop":
          // EAG-P5 v1.1 新增（设计文档 §3.6）：/eag-autonomous-stop <run-id> 命令分发
          // payload 类型为 EagAutonomousStopRequest | null，由 EagCommandParser.parse() 通过
          // 前缀匹配（优先于 /eag-autonomous）识别后从命令字符串解析 runId
          await this.handleEagAutonomousStopCommand(sessionId, userPrompt, eagCommand.payload, controller);
          return;
        case "eag-graph":
          // Loop-Graph 融合方案 Phase 5（设计文档 §12.2 / §14）：/eag-graph 命令分发
          // payload 类型为 EagGraphRequest | null，由 EagCommandParser.parse() 通过
          // 前缀匹配识别后从 userPrompt.messageParams.graphRequest 提取（D-S3-7 注入模式）
          // 或从命令字符串内联参数解析（extractEagGraphRequestFromPrompt）
          await this.handleEagGraphCommand(sessionId, userPrompt, eagCommand.payload, controller);
          return;
        default:
          // 理论不可达（eagCommand.kind !== "unknown" 已过滤兜底分支）
          // 防御性编程：未知 kind 不做处理，落入下方非 EAG 流程
          break;
      }
    }

    // EAG LLM 动态编排建议层（2026-07-24 新增）
    // 仅当显式命令未命中、建议层已注入、用户输入非空且非 /continue 时触发
    // 第一阶段只做建议，不自动执行任何 EAG 命令
    //
    // BUGFIX 2026-07-26：原实现无条件 return，导致 direct_chat 场景下 LLM 主对话被阻断。
    // 根因：handleEagDynamicSuggestion 返回 false 表示"应继续 LLM 主对话"，
    // 但原代码无视返回值直接 return，导致所有非 EAG 命令的用户输入（如"保存到文档"）
    // 都不会触发 activateSession，LLM 永远不被调用，用户看不到任何回复。
    // 修复：根据返回值决定是否 return。false 时继续执行下方主对话逻辑（追加用户消息 + activateSession）。
    // 注意：handleEagDynamicSuggestion 在 direct_chat/异常分支不追加用户消息，
    // 由下方 replySession 主流程统一追加，避免重复。
    if (
      this.eagDynamicSuggester &&
      this.eagDynamicSuggester.isEnabled() &&
      typeof userPrompt.text === "string" &&
      userPrompt.text.trim().length > 0 &&
      !this.isContinuePrompt(userPrompt)
    ) {
      const handledBySuggester = await this.handleEagDynamicSuggestion(sessionId, userPrompt, controller);
      // handledBySuggester === true：建议层已处理（ask_clarification / suggest_*），结束当前 turn
      // handledBySuggester === false：建议层判定为 direct_chat 或异常，继续 LLM 主对话
      if (handledBySuggester) {
        return;
      }
      // direct_chat：继续执行下方主对话流程（追加用户消息 + skill matching + activateSession）
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

    this.fileHistoryCoordinator.ensureFileHistorySession(sessionId);
    // fork 侧：检查点统一走 fileHistoryCoordinator（与上游 this.ensureFileHistorySession/
    // this.recordUserPromptCheckpoint 语义一致，操作同一 file-history git 仓库）；
    // 用户手动改动文件时注入系统提示，告知 LLM 存在会话外修改
    const checkpoint = this.fileHistoryCoordinator.recordUserPromptCheckpoint(sessionId);
    if (checkpoint.changedFilePaths.length) {
      const content = `Note that the user manually modified these files:\n${checkpoint.changedFilePaths.join("\n")}`;
      this.appendSessionMessage(sessionId, this.buildSystemMessage(sessionId, content));
    }
    const userMessage = this.buildUserMessage(sessionId, userPrompt);
    this.appendSessionMessage(sessionId, userMessage);

    // 上游 v0.3.1：命中技能列表（用于下方技能目录消息合并）。
    // 采纳上游语义：匹配技能仅记入目录快照（LLM 经 skill 工具按需加载），
    // 不再自动注入技能消息（与 createSession 的语义调整保持一致）
    let matchedSkills: SkillInfo[] = [];
    if (userPrompt.text) {
      const skills = await this.listSkills(sessionId);
      const skillNames = await this.identifyMatchingSkillNames(skills, userPrompt.text, { signal, sessionId });
      this.throwIfAborted(signal);
      const skillSet = new Set(skillNames);
      matchedSkills = skills.filter((skill) => skillSet.has(skill.name));
    }
    userPrompt.skills = await this.normalizeSkills(userPrompt.skills, sessionId);
    this.throwIfAborted(signal);

    this.appendSkillMessages(sessionId, userPrompt.skills);
    // 上游 v0.3.1：追加技能目录消息（合并预加载目录与本次命中技能，去重后输出给 LLM）
    this.appendSkillCatalogMessage(
      sessionId,
      this.mergeSkillCatalog(
        this.listPreloadedSkillCatalog(sessionId),
        matchedSkills.map((skill) => ({ name: skill.name, description: skill.description }))
      )
    );
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

  // ============================================================================
  // EAG 命令分发区域（@experimental）
  // ============================================================================
  // 重要提示：以下方法为 EAG 命令分发逻辑，CLI 层未默认注入任何 EAG orchestrator。
  // - 已启用：handleEagDynamicSuggestion（通过 EagDynamicSuggester 工厂函数注入）
  // - 未启用：handleEagBuildCommand / handleEagDesignCommand / handleEagTestCommand /
  //   handleEagRunCommand / handleEagResumeCommand / handleEagStatusCommand /
  //   handleEagDeployCommand / handleEagAutonomousCommand / handleEagGraphCommand
  //   （需要通过 SessionManagerOptions 注入对应 orchestrator 才能启用）
  // 启用方式详见 docs/dev/ADR-EAG-001-experimental-status.md
  // ============================================================================

  /**
   * EAG LLM 动态编排建议层入口（2026-07-24 新增）
   *
   * 在显式 EAG 命令未命中时，调用 EagDynamicSuggester 判断任务粒度并给出建议。
   * 第一阶段只做建议，不自动执行任何 EAG 命令。
   *
   * 算法：
   * 1. 记录用户输入到消息历史。
   * 2. 若存在待澄清问题，解析用户回复为选项值数组（clarification）。
   * 3. 调用 suggester.suggest() 获取建议（携带 clarification 时以原始目标重新 refine）。
   * 4. ask_clarification：展示单选/多选问题与选项，并记录 pending 状态等待下一轮回复。
   * 5. suggest_*：通过 onAssistantMessage 展示建议文本。
   * 6. direct_chat：落入下方 LLM 主对话（追加用户消息后返回 false，由调用方继续）。
   *
   * @param sessionId 会话 ID
   * @param userPrompt 用户输入
   * @param controller 中断控制器
   * @returns 是否已处理（true 表示已发送建议并应结束当前 turn，false 表示应继续主对话）
   */
  private async handleEagDynamicSuggestion(
    sessionId: string,
    userPrompt: UserPromptContent,
    controller?: AbortController
  ): Promise<boolean> {
    const signal = controller?.signal;
    this.throwIfAborted(signal);

    // BUGFIX 2026-07-26：原实现在此处无条件追加用户消息，导致 direct_chat 场景下
    // replySession 主流程会重复追加（replySession 第 2298-2299 行也调用 appendSessionMessage）。
    // 修复：移除此处的无条件追加，改为仅在非 direct_chat 分支追加（即建议层确实要发送
    // 澄清问题或建议文本时才记录用户输入）。direct_chat / 异常分支不追加，由 replySession
    // 主流程统一追加，避免重复并保证 LLM 主对话能正常看到用户消息。
    try {
      // 步骤 2：检测是否存在待澄清问题
      const pending = this.pendingEagClarifications.get(sessionId);
      let goal = userPrompt.text ?? "";
      let clarification: ReadonlyArray<string> | undefined;

      if (pending && pending.round > 0) {
        const answers = this.parseClarificationAnswer(goal, pending);
        if (answers.length > 0) {
          clarification = Object.freeze([...answers]);
          goal = pending.originalGoal;
        }
        // 答案无效时继续以当前输入作为目标，让 LLM 自行处理或再次澄清
      }

      // 步骤 3：调用建议器（携带 clarification 时即为 refine 流程）
      // 传入合并后的全部命令描述符（EAG + team/rules/slash），使 LLM 能建议全部命令体系
      // 注意：此处不追加用户消息，suggester 通过 goal 参数获取当前用户输入，
      // recentMessages 仅包含历史消息（不含当前输入），符合 suggester 设计意图。
      const suggestion = await this.eagDynamicSuggester!.suggest({
        sessionId,
        projectRoot: this.projectRoot,
        goal,
        recentMessages: this.getRecentSessionMessages(sessionId, 10),
        availableCommands: this.listAvailableCommands(),
        clarification,
      });

      // 无论新建议是什么，先清除旧的 pending 状态（避免重复命中）
      this.pendingEagClarifications.delete(sessionId);

      // 步骤 4：direct_chat 建议 → 继续 LLM 主对话
      // direct_chat 不追加用户消息，由 replySession 主流程统一追加（避免重复）
      if (suggestion.type === "direct_chat") {
        return false;
      }

      // 步骤 4.5：非 direct_chat 分支需要记录用户输入到会话日志
      // ask_clarification / suggest_* 分支将发送建议文本，需先记录用户消息，
      // 保证会话日志完整（用户输入 + 助手建议成对出现）
      const userMessage = this.buildUserMessage(sessionId, userPrompt);
      this.appendSessionMessage(sessionId, userMessage);

      // 步骤 5：ask_clarification → 展示单选/多选问题与选项，并记录 pending 状态
      if (suggestion.type === "ask_clarification") {
        const nextRound = pending ? pending.round + 1 : 1;
        if (nextRound > MAX_EAG_CLARIFICATION_ROUNDS) {
          // 超过最大澄清轮次，安全降级，避免无限循环
          const fallbackMessage =
            "已经澄清了多次仍无法确定最佳方案，我先按当前理解给出建议。你可以直接告诉我更具体的需求，或运行对应的 /eag-xxx 命令。";
          const assistantMessage = this.buildAssistantMessage(sessionId, fallbackMessage, null);
          this.onAssistantMessage(assistantMessage, false);
          this.updateSessionEntry(sessionId, (entry) => ({
            ...entry,
            status: "completed",
            updateTime: new Date().toISOString(),
          }));
          return true;
        }

        this.pendingEagClarifications.set(sessionId, {
          question: suggestion.question,
          options: suggestion.options,
          multiSelect: suggestion.multiSelect,
          originalGoal: goal,
          round: nextRound,
        });

        const clarificationMessage = this.buildClarificationMessage(suggestion);
        const assistantMessage = this.buildAssistantMessage(sessionId, clarificationMessage, null);
        this.onAssistantMessage(assistantMessage, false);
        this.updateSessionEntry(sessionId, (entry) => ({
          ...entry,
          status: "completed",
          updateTime: new Date().toISOString(),
        }));
        return true;
      }

      // 步骤 6：suggest_command / suggest_autonomous / suggest_graph → 展示建议
      const assistantMessage = this.buildAssistantMessage(sessionId, suggestion.messageToUser, null);
      this.onAssistantMessage(assistantMessage, false);
      this.updateSessionEntry(sessionId, (entry) => ({
        ...entry,
        status: "completed",
        updateTime: new Date().toISOString(),
      }));
      return true;
    } catch (error) {
      // 失败安全：建议层异常时不阻塞主对话
      this.pendingEagClarifications.delete(sessionId);
      const reason = error instanceof Error ? error.message : String(error);
      console.error(`handleEagDynamicSuggestion 异常：${reason}`);
      return false;
    }
  }

  /**
   * 构建澄清问题的展示文本
   *
   * 在 CLI/对话场景下，通过 assistant message 向用户展示问题与选项。
   * 调用方可根据此文本让用户回复选项序号或 value；支持单选与多选。
   *
   * @param suggestion ask_clarification 建议
   * @returns 展示给用户的 Markdown 文本
   */
  private buildClarificationMessage(suggestion: Extract<EagDynamicSuggestion, { type: "ask_clarification" }>): string {
    const lines: string[] = [suggestion.question, ""];
    suggestion.options.forEach((opt, index) => {
      lines.push(`${index + 1}. **${opt.label}**${opt.description ? ` — ${opt.description}` : ""}`);
    });
    lines.push("");
    lines.push(suggestion.multiSelect ? "可多选，回复选项序号（如：1,3）或选项值" : "请回复选项序号（如：1）或选项值");
    return lines.join("\n");
  }

  /**
   * 解析用户对澄清问题的回复
   *
   * 支持以下输入格式：
   * - 单选："1"、"OAuth"、"1. OAuth"
   * - 多选："1,3"、"1 3"、"OAuth, JWT"
   * - 混合："1, JWT"
   *
   * 解析规则：
   * 1. 先按逗号/空格/分号/顿号分割输入。
   * 2. 若片段为纯数字且落在选项序号范围内，映射为对应 option.value。
   * 3. 否则尝试直接与某个 option.value 或 option.label 匹配（大小写不敏感）。
   * 4. 单选时只取第一个有效选项；多选时收集所有有效选项并去重。
   *
   * @param text 用户回复文本
   * @param pending 待澄清状态
   * @returns 选中的 option.value 数组
   */
  private parseClarificationAnswer(text: string, pending: Readonly<EagClarificationPending>): ReadonlyArray<string> {
    const trimmed = text.trim();
    if (!trimmed) {
      return Object.freeze([]);
    }

    // 按常见分隔符拆分：逗号、空格、分号、顿号、竖线
    const segments = trimmed
      .split(/[,，;；、|\s]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    const selected = new Set<string>();
    for (const segment of segments) {
      // 去除可能的前缀序号标记，如 "1."、"1)"
      const stripped = segment.replace(/^\d+[..)]\s*/, "");
      const candidate = stripped || segment;
      const lower = candidate.toLowerCase();

      // 尝试按序号匹配
      const indexMatch = /^\d+$/.test(candidate) ? parseInt(candidate, 10) - 1 : -1;
      if (indexMatch >= 0 && indexMatch < pending.options.length) {
        selected.add(pending.options[indexMatch].value);
        continue;
      }

      // 尝试按 value 或 label 匹配（大小写不敏感）
      const matched = pending.options.find(
        (opt) => opt.value.toLowerCase() === lower || opt.label.toLowerCase() === lower
      );
      if (matched) {
        selected.add(matched.value);
      }
    }

    const result = Array.from(selected);
    if (!pending.multiSelect && result.length > 1) {
      // 单选场景下只保留第一个有效选择
      return Object.freeze([result[0]]);
    }
    return Object.freeze(result);
  }

  /**
   * 获取当前环境实际支持的 EAG 命令清单
   *
   * 根据已注入的 orchestrator 返回可用命令列表，用于建议层 prompt。
   *
   * @returns EagCommandKind 数组
   */
  private listAvailableEagCommands(): EagCommandKind[] {
    const commands: EagCommandKind[] = [];
    if (this.designOrchestrator) commands.push("eag-design");
    if (this.codingOrchestrator) commands.push("eag-build");
    if (this.testingOrchestrator) commands.push("eag-test");
    if (this.runStateStore) {
      commands.push("eag-run", "eag-resume", "eag-status");
    }
    if (this.devopsOrchestrator) commands.push("eag-deploy");
    if (this.autonomousOrchestrator) {
      commands.push("eag-autonomous", "eag-autonomous-status", "eag-autonomous-stop");
    }
    if (this.graphLoopOrchestratorOptions) commands.push("eag-graph");
    return commands;
  }

  /**
   * EAG 命令描述符映射表
   *
   * 将 EagCommandKind 映射为 DynamicCommandDescriptor，供 listAvailableCommands() 使用。
   * 描述文本注入 LLM prompt，帮助 LLM 理解每个 EAG 命令的用途和前置条件。
   */
  private static readonly EAG_COMMAND_DESCRIPTOR_MAP: Readonly<Record<EagCommandKind, DynamicCommandDescriptor>> =
    Object.freeze({
      "eag-build": Object.freeze({
        category: "eag",
        id: "eag-build",
        name: "/eag-build",
        description: "编码实现阶段。需要已提供 spec.md / plan.md / tasks.md 或任务分解结果，不建议凭空使用。",
      }),
      "eag-design": Object.freeze({
        category: "eag",
        id: "eag-design",
        name: "/eag-design",
        description: "设计阶段。接受原始需求描述，生成架构/领域模型/任务分解。",
      }),
      "eag-test": Object.freeze({
        category: "eag",
        id: "eag-test",
        name: "/eag-test",
        description: "测试阶段。需要已提供被测代码或测试计划。",
      }),
      "eag-run": Object.freeze({
        category: "eag",
        id: "eag-run",
        name: "/eag-run",
        description: "继续执行一次已存在的 run。",
      }),
      "eag-resume": Object.freeze({
        category: "eag",
        id: "eag-resume",
        name: "/eag-resume",
        description: "恢复一个已暂停/中断的 run。",
      }),
      "eag-status": Object.freeze({
        category: "eag",
        id: "eag-status",
        name: "/eag-status",
        description: "查询当前或指定 run 的状态。",
      }),
      "eag-deploy": Object.freeze({
        category: "eag",
        id: "eag-deploy",
        name: "/eag-deploy",
        description: "部署阶段。需要已完成构建产物和部署配置。",
      }),
      "eag-autonomous": Object.freeze({
        category: "eag",
        id: "eag-autonomous",
        name: "/eag-autonomous",
        description: "多阶段自动循环（plan → dev → verify → fix）。适合需求模糊、需要自动设计并实现的功能。",
      }),
      "eag-autonomous-status": Object.freeze({
        category: "eag",
        id: "eag-autonomous-status",
        name: "/eag-autonomous-status",
        description: "查询无人值守 run 的状态。",
      }),
      "eag-autonomous-stop": Object.freeze({
        category: "eag",
        id: "eag-autonomous-stop",
        name: "/eag-autonomous-stop",
        description: "中止或回滚无人值守 run。",
      }),
      "eag-graph": Object.freeze({
        category: "eag",
        id: "eag-graph",
        name: "/eag-graph",
        description: "显式图编排入口。需要用户已提供图定义 JSON 文件，或明确需要 DAG、并行分支、条件路由。",
      }),
    } as const);

  /**
   * 获取全部可用命令描述符（EAG + team/rules/slash）
   *
   * 将 listAvailableEagCommands() 返回的 EAG 命令转换为 DynamicCommandDescriptor，
   * 再与外部注入的 dynamicCommandDescriptors（team/rules/slash）合并，
   * 供建议层 prompt 使用，使 LLM 能建议全部命令体系的命令。
   *
   * @returns 合并后的 DynamicCommandDescriptor 数组
   */
  private listAvailableCommands(): ReadonlyArray<DynamicCommandDescriptor> {
    // 步骤 1：将可用的 EAG 命令转换为描述符
    const eagCommands = this.listAvailableEagCommands();
    const eagDescriptors: DynamicCommandDescriptor[] = eagCommands.map(
      (kind) => SessionManager.EAG_COMMAND_DESCRIPTOR_MAP[kind]
    );

    // 步骤 2：合并外部注入的描述符（team/rules/slash）
    const externalDescriptors = this.dynamicCommandDescriptors ?? [];

    // 步骤 3：合并并返回（EAG 命令优先，外部命令在后）
    return Object.freeze([...eagDescriptors, ...externalDescriptors]);
  }

  /**
   * 获取会话最近 N 条用户/助手消息
   *
   * 用于 EAG 动态建议层 prompt 注入，仅保留 role 与 content 两个字段。
   *
   * @param sessionId 会话 ID
   * @param limit 最大返回条数
   * @returns 最近消息数组（role/content 形态）
   */
  private getRecentSessionMessages(
    sessionId: string,
    limit: number
  ): Array<{ role: "user" | "assistant"; content: string }> {
    return this.listSessionMessages(sessionId)
      .filter((message): message is SessionMessage & { role: "user" | "assistant" } =>
        ["user", "assistant"].includes(message.role)
      )
      .slice(-limit)
      .map((message) => ({ role: message.role, content: message.content ?? "" }));
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
  // EAG-P5 Phase 5.3 TASK-P5-3.1-006：/eag-autonomous 命令处理器
  // ============================================================================

  /**
   * 处理 /eag-autonomous 命令（EAG-P5 Phase 5.3 TASK-P5-3.1-006）
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
  // EAG-P5 v1.1 新增（设计文档 §3.6）：
  // /eag-autonomous-status 与 /eag-autonomous-stop 命令处理器
  // ============================================================================

  /**
   * 准备 /eag-autonomous-{status|stop} 子命令的公共前置逻辑（P2-8 抽取）
   *
   * handleEagAutonomousStatusCommand 与 handleEagAutonomousStopCommand 的步骤 1-4
   * 逻辑完全一致，仅命令标签和请求类型不同。此方法将公共逻辑集中维护：
   * 1. 记录用户输入到消息历史
   * 2. 更新 session 状态为 processing
   * 3. 校验外挂依赖 autonomousOrchestrator（未注入时 fail-closed）
   * 4. 校验 request payload（null 时从命令字符串重新解析以获取错误详情）
   *
   * 设计决策（对齐 Karpathy Simplicity First）：
   * - 仅抽取步骤 1-4，步骤 5-7（调用 orchestrator + 渲染结果 + 更新状态）
   *   因调用方法（status vs stop）和状态更新逻辑差异较大，保留在各 handler 中
   * - 使用泛型 TRequest 处理 EagAutonomousStatusRequest / EagAutonomousStopRequest 类型差异
   * - 返回联合类型：成功时返回 { request, orchestrator }，失败时返回 { handled: true }
   *   调用方通过 "handled" in result 判断是否已处理错误（已处理则直接 return）
   *
   * @param sessionId 会话 ID
   * @param userPrompt 用户输入
   * @param request 预装配的请求对象（可空）
   * @param commandLabel 命令标签（如 "[EAG Autonomous Status]"，用于错误消息前缀）
   * @param expectedFormat 期望的命令格式（如 "/eag-autonomous-status <run-id>"）
   * @param parseErrorLabel 解析错误标签（如 "EagAutonomousStatusRequest"）
   * @param reparseFn 重新解析函数（payload 为 null 时调用以获取错误详情）
   * @param controller 中断控制器
   * @returns 成功时返回 { request: TRequest, orchestrator: AutonomousOrchestrator }，
   *          失败时返回 { handled: true }（调用方应直接 return）
   */
  private async prepareEagAutonomousSubcommand<TRequest>(
    sessionId: string,
    userPrompt: UserPromptContent,
    request: TRequest | null,
    commandLabel: string,
    expectedFormat: string,
    parseErrorLabel: string,
    reparseFn: (prompt: string) => TRequest,
    controller?: AbortController
  ): Promise<{ request: TRequest; orchestrator: AutonomousOrchestrator } | { handled: true }> {
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
        "AutonomousOrchestrator 未注入：请在 SessionManagerOptions.autonomousOrchestrator 配置后重启（参考设计文档 v1.1 §3.6 / §5 CLI 命令规范）";
      this.updateSessionEntry(sessionId, (entry) => ({
        ...entry,
        status: "failed",
        failReason: errMsg,
        updateTime: new Date().toISOString(),
      }));
      this.onAssistantMessage(this.buildAssistantMessage(sessionId, `${commandLabel} ${errMsg}`, null), false);
      return { handled: true };
    }

    // 步骤 4：校验 request payload
    // EagCommandParser.parse() 已通过命令字符串解析 payload，但解析失败时 payload 为 null
    // 此时重新调用 reparseFn(userPrompt.text) 以获取具体错误信息
    let validatedRequest: TRequest;
    if (request) {
      validatedRequest = request;
    } else {
      // payload null：尝试从命令字符串重新解析以获取错误详情
      let parseErrorMsg: string;
      try {
        reparseFn(String(userPrompt.text ?? ""));
        // 理论不可达：若 parser 已返回 null，重新解析应该抛异常
        parseErrorMsg = `${parseErrorLabel} 解析返回 null 但未抛异常（理论不可达，请检查 EagCommandParser 实现）`;
      } catch (parseErr) {
        parseErrorMsg = parseErr instanceof Error ? parseErr.message : String(parseErr);
      }
      const errMsg = `${parseErrorLabel} 解析失败：${parseErrorMsg}（期望格式：${expectedFormat}）`;
      this.updateSessionEntry(sessionId, (entry) => ({
        ...entry,
        status: "failed",
        failReason: errMsg,
        updateTime: new Date().toISOString(),
      }));
      this.onAssistantMessage(this.buildAssistantMessage(sessionId, `${commandLabel} ${errMsg}`, null), false);
      return { handled: true };
    }

    return { request: validatedRequest, orchestrator: this.autonomousOrchestrator };
  }

  /**
   * 处理 /eag-autonomous-status 命令（设计文档 v1.1 §3.6）
   *
   * 职责：
   * 1. [公共前置] 记录用户输入 / 更新 processing / 校验依赖 / 校验 payload（P2-8 抽取到 prepareEagAutonomousSubcommand）
   * 2. 调用 orchestrator.status(runId, projectRoot)
   * 3. 通过 onAssistantMessage 渲染 Markdown 报告
   * 4. 更新 session 状态为 completed
   *
   * 设计决策（对齐设计文档 v1.1 §4.7 P1-N2）：
   * - 不新增 handler 类，由 session.ts 私有方法直接处理
   * - 与 handleEagAutonomousCommand 的差异：无需装配 AutonomousRunRequest，无复杂报告渲染
   * - 仅调用 orchestrator.status() + 渲染 result.report
   *
   * 不可变优先原则：
   * - EagAutonomousStatusRequest 由 EagCommandParser.parse() 冻结后传入
   * - AutonomousStatusResult 由 orchestrator.status() 内部冻结后返回
   * - 不修改任何外部状态，所有副作用通过 onAssistantMessage / updateSessionEntry 路由
   *
   * @param sessionId 会话 ID
   * @param userPrompt 用户输入（仅用于写入用户消息历史 + 错误回显时的命令字符串）
   * @param request 预装配的 EagAutonomousStatusRequest（由 EagCommandParser.parse() 提取，可空）
   * @param controller 中断控制器（用于响应 abort 信号）
   */
  private async handleEagAutonomousStatusCommand(
    sessionId: string,
    userPrompt: UserPromptContent,
    request: EagAutonomousStatusRequest | null,
    controller?: AbortController
  ): Promise<void> {
    const signal = controller?.signal;

    // 步骤 1-4：公共前置逻辑（P2-8 抽取到 prepareEagAutonomousSubcommand）
    const prepared = await this.prepareEagAutonomousSubcommand(
      sessionId,
      userPrompt,
      request,
      "[EAG Autonomous Status]",
      "/eag-autonomous-status <run-id>",
      "EagAutonomousStatusRequest",
      extractEagAutonomousStatusRequestFromPrompt,
      controller
    );
    if ("handled" in prepared) {
      return;
    }
    const { request: validatedRequest, orchestrator } = prepared;

    // 步骤 5：调用 orchestrator.status(runId, projectRoot)
    // 设计说明：status() 内部从 RunStateStore 加载最新状态快照并格式化为 Markdown 报告
    // 调用前再次检查 abort 信号（对齐 handleEagAutonomousCommand 的设计）
    this.throwIfAborted(signal);
    let result: Awaited<ReturnType<AutonomousOrchestrator["status"]>>;
    try {
      result = await orchestrator.status(validatedRequest.runId, this.projectRoot);
    } catch (e) {
      // 异常兜底：orchestrator.status() 内部异常（如文件系统错误）
      const isAborted = this.isAbortLikeError(e) || signal?.aborted === true;
      const errMsg = e instanceof Error ? e.message : String(e);
      this.updateSessionEntry(sessionId, (entry) => ({
        ...entry,
        status: "failed",
        failReason: isAborted ? `Autonomous Status 查询被用户中断：${errMsg}` : `Autonomous Status 查询异常：${errMsg}`,
        updateTime: new Date().toISOString(),
      }));
      this.onAssistantMessage(
        this.buildAssistantMessage(
          sessionId,
          isAborted
            ? `[EAG Autonomous Status] 查询被用户中断：${errMsg}`
            : `[EAG Autonomous Status] 查询异常：${errMsg}\n请检查 RunStateStore 的持久化目录（.eag/p5/run-state/）是否可读写。`,
          null
        ),
        false
      );
      return;
    }

    // 步骤 6：渲染结果摘要（result.report 已由 orchestrator.status() 装配为 Markdown 格式）
    if (signal?.aborted) {
      this.updateSessionEntry(sessionId, (entry) => ({
        ...entry,
        status: "failed",
        failReason: "Autonomous Status 查询被用户中断（查询完成后）",
        updateTime: new Date().toISOString(),
      }));
      this.onAssistantMessage(
        this.buildAssistantMessage(
          sessionId,
          `[EAG Autonomous Status] 查询已完成但被用户中断，结果未渲染。found: ${result.found}`,
          null
        ),
        false
      );
      return;
    }
    this.onAssistantMessage(this.buildAssistantMessage(sessionId, result.report, null), false);

    // 步骤 7：更新 session 状态为 completed
    // status 查询是只读操作，无论 found=true/false 都视为 completed
    this.updateSessionEntry(sessionId, (entry) => ({
      ...entry,
      status: "completed",
      failReason: null,
      updateTime: new Date().toISOString(),
    }));
  }

  /**
   * 处理 /eag-autonomous-stop 命令（设计文档 v1.1 §3.6）
   *
   * 职责：
   * 1. [公共前置] 记录用户输入 / 更新 processing / 校验依赖 / 校验 payload（P2-8 抽取到 prepareEagAutonomousSubcommand）
   * 2. 调用 orchestrator.stop(runId, projectRoot)
   * 3. 通过 onAssistantMessage 渲染 Markdown 报告
   * 4. 更新 session 状态（依据 result.success）
   *
   * 设计决策（对齐设计文档 v1.1 §4.7 P1-N2）：
   * - 不新增 handler 类，由 session.ts 私有方法直接处理
   * - 与 handleEagAutonomousCommand 的差异：无需装配 AutonomousRunRequest，无复杂报告渲染
   * - 仅调用 orchestrator.stop() + 渲染 result.report
   *
   * @param sessionId 会话 ID
   * @param userPrompt 用户输入（仅用于写入用户消息历史 + 错误回显时的命令字符串）
   * @param request 预装配的 EagAutonomousStopRequest（由 EagCommandParser.parse() 提取，可空）
   * @param controller 中断控制器（用于响应 abort 信号）
   */
  private async handleEagAutonomousStopCommand(
    sessionId: string,
    userPrompt: UserPromptContent,
    request: EagAutonomousStopRequest | null,
    controller?: AbortController
  ): Promise<void> {
    const signal = controller?.signal;

    // 步骤 1-4：公共前置逻辑（P2-8 抽取到 prepareEagAutonomousSubcommand）
    const prepared = await this.prepareEagAutonomousSubcommand(
      sessionId,
      userPrompt,
      request,
      "[EAG Autonomous Stop]",
      "/eag-autonomous-stop <run-id>",
      "EagAutonomousStopRequest",
      extractEagAutonomousStopRequestFromPrompt,
      controller
    );
    if ("handled" in prepared) {
      return;
    }
    const { request: validatedRequest, orchestrator } = prepared;

    // 步骤 5：调用 orchestrator.stop(runId, projectRoot)
    // 设计说明：stop() 根据 RunState.status 决定行为：
    //   - running/paused → 创建 abort 标志文件，run() 在下次迭代检测并中止
    //   - completed/failed/aborted → 返回回滚信息（HEAD SHA + 未提交清单）
    this.throwIfAborted(signal);
    let result: Awaited<ReturnType<AutonomousOrchestrator["stop"]>>;
    try {
      result = await orchestrator.stop(validatedRequest.runId, this.projectRoot);
    } catch (e) {
      // 异常兜底：orchestrator.stop() 内部异常（如文件系统错误 / git 命令执行失败）
      const isAborted = this.isAbortLikeError(e) || signal?.aborted === true;
      const errMsg = e instanceof Error ? e.message : String(e);
      this.updateSessionEntry(sessionId, (entry) => ({
        ...entry,
        status: "failed",
        failReason: isAborted ? `Autonomous Stop 被用户中断：${errMsg}` : `Autonomous Stop 异常：${errMsg}`,
        updateTime: new Date().toISOString(),
      }));
      this.onAssistantMessage(
        this.buildAssistantMessage(
          sessionId,
          isAborted
            ? `[EAG Autonomous Stop] 操作被用户中断：${errMsg}`
            : `[EAG Autonomous Stop] 操作异常：${errMsg}\n请检查 RunStateStore 的持久化目录（.eag/p5/run-state/）与 abort-flags 目录（.eag/p5/abort-flags/）是否可读写。`,
          null
        ),
        false
      );
      return;
    }

    // 步骤 6：渲染结果摘要（result.report 已由 orchestrator.stop() 装配为 Markdown 格式）
    if (signal?.aborted) {
      this.updateSessionEntry(sessionId, (entry) => ({
        ...entry,
        status: "failed",
        failReason: "Autonomous Stop 操作被用户中断（操作完成后）",
        updateTime: new Date().toISOString(),
      }));
      this.onAssistantMessage(
        this.buildAssistantMessage(
          sessionId,
          `[EAG Autonomous Stop] 操作已完成但被用户中断，结果未渲染。success: ${result.success}, action: ${result.action}`,
          null
        ),
        false
      );
      return;
    }
    this.onAssistantMessage(this.buildAssistantMessage(sessionId, result.report, null), false);

    // 步骤 7：更新 session 状态（依据 result.success）
    // - success=true：session 标记 completed（无论 action=abort 还是 rollback，stop 操作本身成功）
    // - success=false：session 标记 failed（如 runId 未找到）
    this.updateSessionEntry(sessionId, (entry) => ({
      ...entry,
      status: result.success ? "completed" : "failed",
      failReason: result.success ? null : `Autonomous Stop 失败：${result.report}`,
      updateTime: new Date().toISOString(),
    }));
  }

  // ============================================================================
  // Loop-Graph 融合方案 Phase 5（设计文档 §12.2 / §14）：
  // /eag-graph 命令处理器
  // ============================================================================

  /**
   * 处理 /eag-graph 命令（Loop-Graph 融合方案 Phase 5）
   *
   * 职责（对齐设计文档 §12.2 + §14 Phase 5 + handleEagAutonomousCommand 同构模式）：
   * 1. 记录用户输入到消息历史（保持会话上下文完整）
   * 2. 更新 session 状态为 processing
   * 3. 校验外挂依赖 graphLoopOrchestratorOptions（未注入时 fail-closed 通知用户）
   * 4. 校验 EagGraphRequest payload（null 时从命令字符串重新解析以获取错误详情）
   * 5. 创建 EagGraphCommandHandler 实例并调用 execute(request, projectRoot)
   * 6. 通过 onAssistantMessage 渲染 markdownReport（成功 / 失败两条路径）
   * 7. 更新 session 状态为 completed / failed（依据 result.success）
   *
   * 设计决策（对齐 §5.2 N-M-1 修复 + Karpathy Simplicity First + TOP-1）：
   * - 不在方法内部 new GraphLoopOrchestrator（避免每次命令重复构造）
   * - GraphLoopOrchestrator 的全部依赖（nodeExecutor / edgeResolver / graphScheduler /
   *   graphGuard / predicateRegistry / experienceStore）由调用方在
   *   SessionManagerOptions.graphLoopOrchestratorOptions 中完整装配后注入
   * - EagGraphCommandHandler 内部通过 GraphLifecycleManager 统一初始化、启动、管理生命周期
   * - session.ts 仅负责校验注入 + 装配请求 + 调用 handler.execute() + 渲染结果
   *
   * 错误处理策略（对齐 handleEagAutonomousCommand 模式）：
   * - 依赖未注入：fail-closed，session 标记 failed
   * - payload null：尝试重新解析命令字符串获取错误详情，fail-closed
   * - handler.execute() 抛异常：捕获异常，session 标记 failed
   * - abort 信号：在装配前 / handler 调用前 / handler 调用后三个检查点响应中断
   *
   * 不可变优先（§5.12.4 G-A6d）：
   * - EagGraphRequest 由 EagCommandParser.parse() 冻结后传入
   * - EagGraphCommandResult 由 handler.execute() 内部冻结后返回
   * - 不修改任何外部状态，所有副作用通过 onAssistantMessage / updateSessionEntry 路由
   *
   * @param sessionId 会话 ID
   * @param userPrompt 用户输入（仅用于写入用户消息历史，不参与编排）
   * @param request 预装配的 EagGraphRequest（由 EagCommandParser.parse() 提取，可空）
   * @param controller 中断控制器（用于响应 abort 信号）
   */
  private async handleEagGraphCommand(
    sessionId: string,
    userPrompt: UserPromptContent,
    request: EagGraphRequest | null,
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

    // 步骤 3：校验外挂依赖 graphLoopOrchestratorOptions（未注入时 fail-closed）
    if (!this.graphLoopOrchestratorOptions) {
      const errMsg =
        "GraphLoopOrchestratorOptions 未注入：请在 SessionManagerOptions.graphLoopOrchestratorOptions 配置后重启（参考 §12.2 / §14 Phase 5 + TOP-1）";
      this.updateSessionEntry(sessionId, (entry) => ({
        ...entry,
        status: "failed",
        failReason: errMsg,
        updateTime: new Date().toISOString(),
      }));
      this.onAssistantMessage(this.buildAssistantMessage(sessionId, `[EAG Graph Loop] ${errMsg}`, null), false);
      return;
    }

    // 步骤 4：校验 EagGraphRequest payload
    // EagCommandParser.parse() 已通过两种路径提取 payload：
    //   路径 A：从 userPrompt.messageParams.graphRequest 提取（UI 表单模式）
    //   路径 B：从命令字符串内联参数解析（CLI 模式，extractEagGraphRequestFromPrompt）
    // payload 为 null 时表示两种路径均失败：
    //   - 命令字符串前缀匹配成功（/eag-graph）
    //   - 但参数解析抛异常（如 --graph-file 与 --inline-graph 互斥冲突 / --max-depth 取值非法）
    // 此时重新调用 extractEagGraphRequestFromPrompt(userPrompt.text) 以获取具体错误信息
    let validatedRequest: EagGraphRequest;
    if (request) {
      validatedRequest = request;
    } else {
      // payload null：尝试从命令字符串重新解析以获取错误详情
      // 注：进入此分支前置条件为 EagCommandParser.parse() 返回 kind="eag-graph"，
      // 即 userPrompt.text 已通过 typeof string 校验。
      let parseErrorMsg: string;
      try {
        // 重新解析以触发异常并获取错误详情
        extractEagGraphRequestFromPrompt(String(userPrompt.text ?? ""));
        // 理论不可达：若 parser 已返回 null，重新解析应该抛异常
        // 此处兜底：若未抛异常，使用通用错误消息
        parseErrorMsg =
          "EagGraphRequest 解析返回 null 但未抛异常（理论不可达，请检查 EagCommandParser.extractEagGraphRequest 实现）";
      } catch (parseErr) {
        parseErrorMsg = parseErr instanceof Error ? parseErr.message : String(parseErr);
      }
      const errMsg = `EagGraphRequest 解析失败：${parseErrorMsg}（期望格式：/eag-graph --graph-file <路径> 或 /eag-graph --inline-graph <JSON> [--enable-experience-recall] [--max-depth 50]）`;
      this.updateSessionEntry(sessionId, (entry) => ({
        ...entry,
        status: "failed",
        failReason: errMsg,
        updateTime: new Date().toISOString(),
      }));
      this.onAssistantMessage(this.buildAssistantMessage(sessionId, `[EAG Graph Loop] ${errMsg}`, null), false);
      return;
    }

    // 步骤 5：创建 EagGraphCommandHandler 实例并调用 execute()
    // 设计说明：handler 内部完成 WorkGraph 构造 + GraphLifecycleManager 生命周期管理 +
    // Markdown 报告渲染 + 异常兜底，session.ts 仅需调用 execute() 即可
    // 装配前再次检查 abort 信号（对齐 handleEagAutonomousCommand 的设计）
    this.throwIfAborted(signal);
    const handler = new EagGraphCommandHandler(this.graphLoopOrchestratorOptions);
    let result: Readonly<EagGraphCommandResult>;
    try {
      result = await handler.execute(validatedRequest, this.projectRoot);
    } catch (e) {
      // 异常兜底：handler.execute() 内部已 try/catch orchestrator.run()，
      // 此处捕获的是 handler 自身的异常（如 validateRequest 抛错、loadGraphJson 异常）
      const isAborted = this.isAbortLikeError(e) || signal?.aborted === true;
      const errMsg = e instanceof Error ? e.message : String(e);
      this.updateSessionEntry(sessionId, (entry) => ({
        ...entry,
        status: "failed",
        failReason: isAborted ? `Graph Loop 被用户中断：${errMsg}` : `Graph Loop 执行异常：${errMsg}`,
        updateTime: new Date().toISOString(),
      }));
      this.onAssistantMessage(
        this.buildAssistantMessage(
          sessionId,
          isAborted
            ? `[EAG Graph Loop] 编排被用户中断：${errMsg}`
            : `[EAG Graph Loop] 编排异常：${errMsg}\n请检查 GraphLoopOrchestrator 的 5 个核心依赖（nodeExecutor / edgeResolver / graphScheduler / graphGuard / predicateRegistry）配置是否正确，以及图定义 JSON 格式是否合法。`,
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
        failReason: "Graph Loop 被用户中断（编排完成后）",
        updateTime: new Date().toISOString(),
      }));
      this.onAssistantMessage(
        this.buildAssistantMessage(
          sessionId,
          `[EAG Graph Loop] 编排已完成但被用户中断，结果未渲染。success: ${result.success}`,
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
    // - success=true：session 标记 completed（包括 finalStatus=completed / aborted）
    // - success=false：session 标记 failed，failReason 取 errorMessage
    this.updateSessionEntry(sessionId, (entry) => ({
      ...entry,
      status: result.success ? "completed" : "failed",
      failReason: result.success ? null : `Graph Loop 终止：${result.errorMessage}`,
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
    const {
      client,
      apiKey,
      model,
      baseURL,
      temperature,
      thinkingEnabled,
      reasoningEffort,
      debugLogEnabled,
      notify,
      env,
    } = this.createOpenAIClient();
    // Claude 主对话流式接入（2026-07-18 设计 §3）：方法开头一次性解析统一 LLM 客户端，循环内复用。
    // 上游 v0.3.1：解构出 apiKey，供 DeepSeek Files API 上传使用。
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

    // 主对话流式安全参数：与 settings.timeout 对齐，防止 LLM 长期无响应或 reasoning 无限增长。
    // OpenAI 路径当前依赖 SDK 请求级 timeout（默认 600s），此处额外提供流式整体超时；
    // Anthropic 路径在 createLlmMessageStream 中通过 AbortController 实现，因 Anthropic SDK 未配置 timeout。
    const settings = this.getResolvedSettings();
    const settingsTimeout = settings.timeout ?? 0;
    const streamTimeoutMs = settingsTimeout > 0 ? settingsTimeout * 1000 : undefined;
    const maxReasoningLength = 100_000;

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

        // 自动 compact 阈值：以上游 v0.3.1 语义为准——优先用户显式配置的 autoCompactWindow；
        // 未配置时回落 getCompactPromptTokenThreshold（fork 增强版：传入 contextWindow，
        // 按 contextWindow*0.8 计算，DeepSeek V4 系列保留 512K 特殊阈值）
        const resolvedSettings = this.getResolvedSettings();
        const compactPromptTokenThreshold =
          resolvedSettings.autoCompactWindow ?? getCompactPromptTokenThreshold(model, resolvedSettings.contextWindow);
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

        // E2 扩展点（ADR-DI-001 §5.1.2）：检查中断队列，drain 并合成为 system 消息
        //
        // 设计约束（Karpathy Surgical Changes）：
        // - 仅在 interruptQueue 注入时生效，未注入时主循环行为完全不变（零回归）
        // - 每次迭代头部检查（LLM 调用前），保证指令在下一轮 LLM 调用前被消费
        // - FIFO 顺序合并为单条 system 消息（避免多次追加污染上下文）
        // - visible=true 让用户在 UI 中看到注入被消费（§5.1.4 可见性语义）
        // - drain 后队列清空，不会重复消费（§5.1.4 不重放语义）
        //
        // 与 E3 的协作：
        // - E3 在流式 chunk 之间检查队列非空，抛 InjectInterruptError 中断当前流
        // - activateSession catch 块识别 InjectInterruptError，不设 failed，continue
        // - 下一轮迭代头部本处 drain 队列，合成 system 消息
        // - LLM 看到 system 消息自然调整方向（§5.1.1 数据流）
        if (this.interruptQueue && this.interruptQueue.size > 0) {
          // drain 取出全部待处理指令（FIFO 顺序，返回不可变数组）
          const instructions = this.interruptQueue.drain();
          if (instructions.length > 0) {
            // 合并为单条 system 消息追加到会话（含时间戳与原文，便于 LLM 理解上下文）
            // 格式：[<入队时间戳>] 用户注入：<指令文本>
            const combined = instructions.map((i) => `[${i.enqueuedAt}] 用户注入：${i.text}`).join("\n\n");
            // 构建 system 消息：告知 LLM 用户在中途追加了指令，需在后续步骤中纳入考虑
            const injectMessage = this.buildSystemMessage(
              sessionId,
              `[用户在任务执行中追加了以下指令，请在下一步动作中考虑：]\n\n${combined}`,
              null,
              true // visible=true，让用户看到注入被消费（§5.1.4 可见性语义）
            );
            this.appendSessionMessage(sessionId, injectMessage);
            // 通知 UI：注入已被消费（onAssistantMessage 第二参数 false 表示不连接流）
            this.onAssistantMessage(injectMessage, false);
          }
        }

        // 上游 v0.3.1：请求前预处理会话消息（多模态图片消息等转换为请求所需形态）
        const sessionMessages = this.prepareSessionMessagesForRequest(this.listSessionMessages(sessionId));
        // 上游 v0.3.1：DeepSeek Files API 设置（启用时大文件上传至 Files API，消息中仅保留引用）
        const filesSettings = this.getDeepSeekFilesSettings();
        if (filesSettings.enabled && !apiKey) {
          throw new Error("Files API is enabled, but no API key is available for uploads.");
        }
        // 上游 v0.3.1：Files API 启用时构建「引用替换后」的消息（大文件上传并替换为引用）；
        // 未启用时引用列表为空，消息体由下方 OpenAI 分支经 converter 构建（V2 上下文 hook + 多模态）
        let prepared = filesSettings.enabled
          ? await this.buildMessagesWithDeepSeekFiles(
              sessionMessages,
              thinkingEnabled,
              model,
              apiKey!,
              sessionController.signal
            )
          : {
              messages: [] as ChatCompletionMessageParam[],
              references: [] as DeepSeekFileReference[],
            };
        const messages = this.messageConverter.buildMessages(
          sessionMessages,
          thinkingEnabled,
          model,
          this.getResolvedSettings().multimodal
        );
        // v1.1 修改：传入 model 参数，支持 Qwen3 的 chat_template_kwargs.enable_thinking 格式
        const thinkingOptions = buildThinkingRequestOptions(thinkingEnabled, baseURL, reasoningEffort, model);
        // 仅流式调用一处三元分支，前后逻辑共享（2026-07-18 设计 §3 调用点形态）；
        // OpenAI 分支保持原样，Anthropic 分支聚合产物与 OpenAI 形态契约完全一致，
        // 主循环消费面（content/tool_calls/reasoning_content/refusal/usage）零改动。
        // 请求构建按 §6.1：messages 直接传 SessionMessage[]（converter 原生消费，不绕行 OpenAI 形态）；
        // tools 为 getTools 产物的纯字段提取；maxTokens/temperature 省略（client 回落 settings
        // 单一配置源，避免 Claude 侧每次调用产生误导性告警噪声）；signal 与 OpenAI 分支同源。
        // E3 扩展点（ADR-DI-001 §5.1.3）：LLM 调用包裹 try/catch 识别 InjectInterruptError
        //
        // 设计约束（Karpathy Surgical Changes）：
        // - InjectInterruptError 是流控制信号（用户主动 /inject 触发），不是错误
        // - 捕获后不设置 session 状态为 failed/interrupted，直接 continue 进入下一轮迭代
        // - 下一轮迭代头部（E2 扩展点）drain 队列，合成 system 消息追加到会话
        // - LLM 看到 system 消息自然调整方向（§5.1.1 数据流）
        // - 其他错误向上抛给 activateSession 外层 catch（保持现有错误处理行为不变，零回归）
        // - 未注入 interruptQueue 时，createChatCompletionStream / createLlmMessageStream
        //   不会抛 InjectInterruptError，本 try/catch 等价于直通（零回归）
        let response: { choices?: Array<{ message?: Record<string, unknown> }>; usage?: ModelUsage | null };
        try {
          response = anthropicClient
            ? await this.createLlmMessageStream(
                anthropicClient,
                {
                  messages: sessionMessages,
                  tools: getTools(this.getPromptToolOptions(), this.mcpToolDefinitions).map((tool) => ({
                    name: tool.function.name,
                    description: tool.function.description,
                    parameters: tool.function.parameters,
                  })),
                  thinkingEnabled,
                  signal: sessionController.signal,
                },
                { signal: sessionController.signal, streamTimeoutMs, maxReasoningLength },
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
                  // 上游 v0.3.1：Files API 启用时使用上传后带引用的消息；未启用时使用 converter 构建的多模态消息
                  messages: filesSettings.enabled ? prepared.messages : messages,
                  tools: getTools(this.getPromptToolOptions(), this.mcpToolDefinitions),
                  ...thinkingOptions,
                },
                { signal: sessionController.signal, streamTimeoutMs, maxReasoningLength },
                sessionId,
                {
                  enabled: debugLogEnabled,
                  location: "SessionManager.activateSession",
                  baseURL,
                  params: { iteration, temperature, thinkingEnabled, reasoningEffort },
                }
              );
        } catch (error) {
          // E3 扩展点：识别 InjectInterruptError（流式 chunk 之间抛出的中断信号）
          // - 不设置 session 状态为 failed/interrupted
          // - 不通知用户失败（这是正常的中断注入流程）
          // - continue 进入下一轮迭代，由 E2 drain 队列并合成 system 消息
          if (error instanceof InjectInterruptError) {
            continue;
          }
          // 上游 v0.3.1：Files API 引用被模型拒绝（4xx 拒收）时，失效相关文件缓存并重建引用后重试；
          // 非 Files API 场景或其他错误向上抛给 activateSession 外层 catch（保持现有错误处理行为不变）
          if (!filesSettings.enabled || prepared.references.length === 0 || !this.isRejectedDeepSeekFile(error)) {
            throw error;
          }
          for (const reference of prepared.references) {
            this.deepSeekFiles.invalidate(reference, apiKey!);
          }
          prepared = await this.buildMessagesWithDeepSeekFiles(
            sessionMessages,
            thinkingEnabled,
            model,
            apiKey!,
            sessionController.signal
          );
          // 重试：与首次 OpenAI 分支同参（Files API 引用已重建），超时控制与调试上下文保持一致
          response = await this.createChatCompletionStream(
            client,
            {
              model,
              ...(temperature !== undefined ? { temperature } : {}),
              messages: prepared.messages,
              tools: getTools(this.getPromptToolOptions(), this.mcpToolDefinitions),
              ...thinkingOptions,
            },
            { signal: sessionController.signal, streamTimeoutMs, maxReasoningLength },
            sessionId,
            {
              enabled: debugLogEnabled,
              location: "SessionManager.activateSession",
              baseURL,
              params: { iteration, temperature, thinkingEnabled, reasoningEffort },
            }
          );
        }

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
              // 上游 v0.3.1：免读权限路径 = 技能扫描根目录 + 会话图片目录（多模态 ReadImage 读取所需）
              readPermissionExemptPaths: this.getReadPermissionExemptPaths(sessionId),
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
      const errMessage = describeLlmError(error);
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

  // ============================================================================
  // ADR-DI-001 §7.1 E4 扩展点：7 个委托方法（动态指令注入与后台子 Agent）
  //
  // 设计约束（Karpathy Surgical Changes + Simplicity First）：
  // - 每个方法仅委托给注入的组件（interruptQueue / taskRegistry / backgroundRunner）
  // - 未注入对应组件时抛错（提示用户命令不可用），不静默忽略
  // - 方法签名与 ADR-DI-001 §7.1 改动点 5 完全一致
  // - 不改变 SessionManager 现有公开 API（零回归）
  // ============================================================================

  /**
   * 注入指令到当前会话的中断队列（/inject 命令入口）
   *
   * ADR-DI-001 §5.1.1 数据流：
   * 用户输入 /inject <指令> → injectInstruction → interruptQueue.enqueue
   * → 主循环下次迭代头部（E2 扩展点）drain → 合成 system 消息追加到会话
   *
   * 设计约束：
   * - 未注入 interruptQueue 时抛错（命令不可用，向后兼容）
   * - text 不能为空字符串（InterruptQueue.enqueue 内部校验）
   * - source 默认 "user"（来自用户 /inject 命令），LLM 工具注入时传 "llm"
   * - 入队后由主循环 drain 消费，本方法不直接触发 LLM 调用
   *
   * @param text 注入指令文本（不能为空）
   * @param source 注入来源（默认 "user"，LLM 工具注入时传 "llm"）
   * @throws {Error} 当 interruptQueue 未注入时
   * @throws {Error} 当 text 为空字符串时
   * @throws {QueueOverflowError} 当队列已满（size >= MAX_QUEUE_SIZE）时
   */
  injectInstruction(text: string, source: InjectSource = "user"): void {
    if (!this.interruptQueue) {
      throw new Error("SessionManager.injectInstruction 失败：interruptQueue 未注入，/inject 命令不可用");
    }
    // 构造不可变的 InjectedInstruction 实例
    const instruction: InjectedInstruction = {
      id: crypto.randomUUID(),
      text,
      enqueuedAt: new Date().toISOString(),
      source,
    };
    // 委托给 InterruptQueue.enqueue（内部校验 text 非空 + 容量上限 + 触发 onEnqueue 回调）
    this.interruptQueue.enqueue(instruction);
  }

  /**
   * 启动后台任务（/bg 命令入口）
   *
   * ADR-DI-001 §5.2.1 数据流：
   * 用户输入 /bg <指令> → startBackgroundTask → backgroundRunner.start
   * → 构造 BackgroundTask → 注册到 TaskRegistry → 异步启动 → 返回 taskId
   *
   * 设计约束（D-1 决策）：
   * - 后台任务使用独立的 SessionManager 实例（由 backgroundRunner.sessionManagerFactory 创建）
   * - 独立 AbortController（取消不影响前台）
   * - 独立 InterruptQueue（支持对后台任务也 /inject）
   * - 立即返回 taskId，任务在后台异步执行（fire-and-steer 模式）
   *
   * Phase 1 限制：
   * - 仅支持 kind="chat"（autonomous kind 留待 Phase 3）
   *
   * @param prompt 初始 prompt 文本（不能为空）
   * @param kind 任务类型（默认 "chat"，Phase 1 仅支持 chat）
   * @returns { taskId: string } 任务 ID（前缀 `t-` + UUID）
   * @throws {Error} 当 backgroundRunner 未注入时
   * @throws {Error} 当 prompt 为空字符串时
   * @throws {Error} 当 kind 不为 "chat" 时（Phase 1 限制）
   * @throws {TaskLimitExceededError} 当任务数已达上限（MAX_CONCURRENT_TASKS）时
   */
  async startBackgroundTask(prompt: string, kind: TaskKind = "chat"): Promise<{ taskId: string }> {
    if (!this.backgroundRunner) {
      throw new Error("SessionManager.startBackgroundTask 失败：backgroundRunner 未注入，/bg 命令不可用");
    }
    // 委托给 BackgroundTaskRunner.start（内部校验 prompt 非空 + kind + 创建 task + 注册 + 启动）
    return this.backgroundRunner.start(prompt, kind);
  }

  /**
   * 列出全部任务（/tasks 命令入口）
   *
   * ADR-DI-001 §5.3.1 数据流：
   * 用户输入 /tasks → listTasks → taskRegistry.list → 返回 readonly BackgroundTask[]
   *
   * 设计约束：
   * - 未注入 taskRegistry 时抛错（命令不可用，向后兼容）
   * - 返回不可变 readonly array（防止外部修改）
   * - 默认仅返回活跃区任务（includeHistory=false）
   * - 支持按 status / kind / includeHistory 过滤
   *
   * @param filter 过滤选项（可选，未提供时返回全部活跃任务）
   * @returns 不可变任务数组（活跃区 + 历史区，按过滤条件筛选）
   * @throws {Error} 当 taskRegistry 未注入时
   */
  listTasks(filter?: TaskListFilter): readonly BackgroundTask[] {
    if (!this.taskRegistry) {
      throw new Error("SessionManager.listTasks 失败：taskRegistry 未注入，/tasks 命令不可用");
    }
    // 委托给 TaskRegistry.list（内部按 filter 过滤活跃区 + 历史区）
    return this.taskRegistry.list(filter);
  }

  /**
   * 切换前台任务（/fg 命令入口）
   *
   * ADR-DI-001 §5.3.2 数据流：
   * 用户输入 /fg <taskId> → setForegroundTask → taskRegistry.setForeground
   * → 切换 UI 关注焦点（不中断其他后台任务）
   *
   * 设计约束：
   * - 未注入 taskRegistry 时抛错（命令不可用，向后兼容）
   * - taskId 必须在活跃区（不在活跃区抛错）
   * - 仅切换 UI 关注焦点，不中断其他后台任务
   * - 切换后用户输入直接作用于新的前台任务
   *
   * @param taskId 任务 ID（必须在活跃区）
   * @throws {Error} 当 taskRegistry 未注入时
   * @throws {Error} 当 taskId 不在活跃区时
   */
  setForegroundTask(taskId: string): void {
    if (!this.taskRegistry) {
      throw new Error("SessionManager.setForegroundTask 失败：taskRegistry 未注入，/fg 命令不可用");
    }
    // 委托给 TaskRegistry.setForeground（内部校验 taskId 在活跃区）
    this.taskRegistry.setForeground(taskId);
  }

  /**
   * 取消指定任务（/cancel 命令入口）
   *
   * ADR-DI-001 §5.3.3 数据流：
   * 用户输入 /cancel <taskId> → cancelTask → task.cancel
   * → controller.abort("cancel") → setState("cancelled")
   *
   * 设计约束：
   * - 未注入 taskRegistry 时抛错（命令不可用，向后兼容）
   * - taskId 必须在活跃区（不在活跃区抛错）
   * - cancel 内部触发 controller.abort（中止 LLM 流 + 杀进程）
   * - cancel 是终态操作，不可恢复（与 pause 区分）
   *
   * @param taskId 任务 ID（必须在活跃区）
   * @param reason 取消原因（可选，记录到 task.error 字段）
   * @throws {Error} 当 taskRegistry 未注入时
   * @throws {Error} 当 taskId 不在活跃区时
   * @throws {InvalidStateTransitionError} 当任务状态为终态或 injecting 时
   */
  async cancelTask(taskId: string, reason?: string): Promise<void> {
    if (!this.taskRegistry) {
      throw new Error("SessionManager.cancelTask 失败：taskRegistry 未注入，/cancel 命令不可用");
    }
    const task = this.taskRegistry.get(taskId);
    if (!task) {
      throw new Error(`SessionManager.cancelTask 失败：task.id=${taskId} 不在活跃区`);
    }
    // 委托给 BackgroundTask.cancel（内部校验状态 + abort + setState("cancelled")）
    task.cancel(reason);
    // 等待一个事件循环，让 onStateChange 中的 setTimeout(0) unregister 执行
    // 注：BackgroundTaskRunner.onStateChange 回调中检测终态后 setTimeout(0) unregister，
    //     这里等待一个事件循环确保 unregister 完成（与 BackgroundTaskRunner.stop 行为一致）
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  }

  /**
   * 暂停当前前台任务（/pause 命令入口）
   *
   * ADR-DI-001 §5.4.1 数据流：
   * 用户输入 /pause → pauseActiveTask → task.pause
   * → controller.abort("pause") → setState("paused")
   *
   * 设计约束：
   * - 未注入 taskRegistry 时抛错（命令不可用，向后兼容）
   * - 仅暂停当前前台任务（taskRegistry.getForegroundId 获取）
   * - 无前台任务时静默返回（不抛错，允许用户在无任务时 /pause）
   * - pause 与 cancel 的区别：pause 转 paused（可 resume），cancel 转 cancelled（终态）
   * - pause 内部触发 controller.abort("pause")，主循环 catch 块识别 pause 信号
   *
   * @throws {Error} 当 taskRegistry 未注入时
   * @throws {InvalidStateTransitionError} 当前台任务状态不为 running 时
   */
  pauseActiveTask(): void {
    if (!this.taskRegistry) {
      throw new Error("SessionManager.pauseActiveTask 失败：taskRegistry 未注入，/pause 命令不可用");
    }
    const foregroundId = this.taskRegistry.getForegroundId();
    if (!foregroundId) {
      // 无前台任务时静默返回（允许用户在无任务时 /pause，不报错）
      return;
    }
    const task = this.taskRegistry.get(foregroundId);
    if (!task) {
      // 前台任务不在活跃区（理论上不应发生，防御性处理）
      return;
    }
    // 委托给 BackgroundTask.pause（内部校验状态 + abort + setState("paused")）
    task.pause();
  }

  /**
   * 恢复指定任务（/resume 命令入口）
   *
   * ADR-DI-001 §5.4.2 数据流：
   * 用户输入 /resume <taskId> → resumeTask → task.resume
   * → onResume 回调重建 controller → setState("running")
   *
   * 设计约束：
   * - 未注入 taskRegistry 时抛错（命令不可用，向后兼容）
   * - taskId 必须在活跃区且状态为 paused（不在活跃区或状态不对抛错）
   * - resume 内部调用 onResume 回调（由 BackgroundTaskRunner 注入）
   * - onResume 回调负责重建 AbortController 并重新启动 LLM 流
   *
   * @param taskId 任务 ID（必须在活跃区且状态为 paused）
   * @throws {Error} 当 taskRegistry 未注入时
   * @throws {Error} 当 taskId 不在活跃区时
   * @throws {InvalidStateTransitionError} 当任务状态不为 paused 时
   * @throws {Error} 当 onResume 回调抛错时（状态保持 paused）
   */
  async resumeTask(taskId: string): Promise<void> {
    if (!this.taskRegistry) {
      throw new Error("SessionManager.resumeTask 失败：taskRegistry 未注入，/resume 命令不可用");
    }
    const task = this.taskRegistry.get(taskId);
    if (!task) {
      throw new Error(`SessionManager.resumeTask 失败：task.id=${taskId} 不在活跃区`);
    }
    // 委托给 BackgroundTask.resume（内部校验状态 + 调用 onResume 回调 + setState("running")）
    await task.resume();
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
      // 上游 v0.3.1：skillCatalog 目录快照消息不参与 compact（保持技能目录信息始终可见）
      if (sessionMessages[i].meta?.skillCatalog) {
        continue;
      }
      sessionMessages[i] = { ...sessionMessages[i], compacted: true, updateTime: now };
    }

    // Qwen3 兼容修复：summaryMessage 使用 role: "user" 而非 "system"
    // 原因：compact 后 summaryMessage 紧跟原始 system 消息（中间 compacted 消息被过滤），
    // 若 role 为 "system"，Qwen3 的 flattenMidConversationSystemMessages 会将其合并到
    // 开头 system 消息中，导致消息列表变为 [system, assistant, ...]，缺少 user query，
    // 触发 Qwen3 vLLM chat_template 的 "No user query found in messages" HTTP 400 错误。
    // 语义上 summary 替代了被压缩的对话（含 user 消息），用 user role 合理；
    // visible:false 保证不影响用户视图。
    const summaryMessage: SessionMessage = {
      id: crypto.randomUUID(),
      sessionId,
      role: "user",
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

  // 工具注册选项（融合双方字段）：model/multimodal/nonInteractive 为上游 v0.3.1 新增，
  // enabledSkills 为 fork P1-T2 新增（PureShowWidget 等 skill 关联工具的条件注册）
  private getPromptToolOptions(): {
    model: string;
    multimodal?: MultimodalMode;
    webSearchEnabled: boolean;
    nonInteractive: boolean;
    enabledSkills: Record<string, boolean>;
  } {
    return {
      model: this.getResolvedSettings().model,
      // 上游 v0.3.1：多模态模式（auto/on/off），决定注册 ReadImage 还是 UnderstandImage
      multimodal: this.getResolvedSettings().multimodal,
      webSearchEnabled: true,
      // 上游 v0.3.1：非交互模式（如 exec/headless），移除 AskUserQuestion 工具与对应文档
      nonInteractive: this.nonInteractive,
      // P1-T2：传递 enabledSkills 给 getTools()，
      // 用于控制 PureShowWidget 等 skill 关联工具的条件注册
      enabledSkills: this.getResolvedSettings().enabledSkills ?? {},
    };
  }

  // 上游 v0.3.1：请求前预处理会话消息——非交互模式（exec/headless）下
  // 系统提示词需按 nonInteractive 选项重建（移除 AskUserQuestion 文档等）
  private prepareSessionMessagesForRequest(messages: SessionMessage[]): SessionMessage[] {
    if (!this.nonInteractive) {
      return messages;
    }

    const systemPromptIndex = messages.findIndex(
      (message) => message.role === "system" && message.content?.includes("# Available Tools")
    );
    if (systemPromptIndex === -1) {
      return messages;
    }

    const prepared = messages.slice();
    prepared[systemPromptIndex] = {
      ...prepared[systemPromptIndex],
      content: getSystemPrompt(this.projectRoot, this.getPromptToolOptions()),
    };
    return prepared;
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

  // 上游 v0.3.1 新增：会话分叉——以指定会话的最后一条消息为基准创建新会话，
  // 复制消息与图片（copySessionImagesForFork）、继承文件历史（GitFileHistory.forkSession），
  // 新会话条目记录 forkedFrom 来源，便于 UI 展示分叉链路
  forkSession(sourceSessionId: string): string {
    const source = this.getSession(sourceSessionId);
    if (!source) {
      throw new Error(`No saved session found with ID "${sourceSessionId}".`);
    }

    const sourceMessages = this.listSessionMessages(sourceSessionId);
    const sourceMessage = sourceMessages.at(-1);
    if (!sourceMessage || typeof sourceMessage.id !== "string" || !sourceMessage.id) {
      throw new Error(`Session "${sourceSessionId}" has no messages to fork.`);
    }

    const sessionId = crypto.randomUUID();
    const now = new Date().toISOString();
    const entry: SessionEntry = {
      id: sessionId,
      summary: source.summary,
      assistantReply: source.assistantReply,
      assistantThinking: source.assistantThinking,
      assistantRefusal: null,
      toolCalls: null,
      status: "completed",
      failReason: null,
      usage: null,
      usagePerModel: null,
      activeTokens: source.activeTokens,
      createTime: now,
      updateTime: now,
      processes: null,
      planMode: source.planMode,
      forkedFrom: {
        sessionId: sourceSessionId,
        messageId: sourceMessage.id,
      },
    };

    // 复制分叉引用的图片文件到新会话图片目录，避免源会话删除后图片失效
    const forkedMessages = this.copySessionImagesForFork(sourceSessionId, sessionId, sourceMessages).map((message) => ({
      ...message,
      sessionId,
    }));
    this.saveSessionMessages(sessionId, forkedMessages);
    // 文件历史同步分叉：新会话的 checkpoint 哈希可继续追溯源会话的文件版本
    this.getFileHistory().forkSession(sourceSessionId, sessionId);

    // 会话条目按更新时间降序写入索引，超出上限（MAX_SESSION_ENTRIES）时淘汰最旧条目并清理资源
    const index = this.loadSessionsIndex();
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

    return sessionId;
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
    return (
      this.listSessionMessages(sessionId)
        .map((message, index) => ({ message, index }))
        // fork：undo 目标判定走 FileHistoryCoordinator（fork 会话恢复链路统一入口）
        .filter(({ message }) => this.fileHistoryCoordinator.isUndoTargetMessage(message))
        .map(({ message, index }) => ({
          message,
          index,
          canRestoreCode: Boolean(
            // fork：checkpoint 哈希可恢复性判定走 FileHistoryCoordinator（与 undo 链路同源）
            message.checkpointHash &&
            this.fileHistoryCoordinator.canRestoreCheckpointHash(sessionId, message.checkpointHash)
          ),
        }))
    );
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
    // fork：代码 checkpoint 恢复走 FileHistoryCoordinator（fork 会话恢复链路统一入口）
    this.fileHistoryCoordinator.restoreCheckpointHash(sessionId, message.checkpointHash);
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

  // S4 拆分说明（2026-08-19）：fork 侧已将 undo/file-history 域的 11 个私有方法整体迁移至
  // FileHistoryCoordinator（fork 调用链统一走 this.fileHistoryCoordinator.*；公开组合层
  // listUndoTargets / restoreSessionConversation / restoreSessionCode 保留在本类）。
  // v0.3.1 合并说明：上游在本类内保留同名私有方法作为基础设施，forkSession（上游新增）、
  // restoreSessionConversation 等上游链路依赖它们；两套入口操作同一 file-history git 仓库
  // （.deepcode/projects/<code>/file-history/.git），语义一致、互不冲突，故双方均保留。
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

  // 上游 v0.3.1：会话图片目录（多模态图片存储位置）与免读权限路径（技能根目录 + 图片目录，
  // 供 ReadImage 等工具免确认读取）
  private getSessionImagesDir(sessionId: string): string {
    const { projectDir } = this.getProjectStorage();
    return path.join(projectDir, "images", sessionId);
  }

  private getReadPermissionExemptPaths(sessionId: string): string[] {
    return [...this.getSkillScanRoots().map((entry) => entry.root), this.getSessionImagesDir(sessionId)];
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
      // 上游 v0.3.1：消息删除时同步清理会话图片目录（多模态图片持久化配套，尽力而为）
      try {
        fs.rmSync(this.getSessionImagesDir(sessionId), { recursive: true, force: true });
      } catch {
        // Ignore cleanup failures, matching message cleanup behavior.
      }
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
      // fork：checkpoint 哈希经 coordinator 读取（与上游 this.getCurrentCheckpointHash
      // 语义一致，操作同一 file-history git 仓库）
      checkpointHash: this.fileHistoryCoordinator.getCurrentCheckpointHash(sessionId),
    };
  }

  // 上游 v0.3.1：多模态图片持久化——当 Files API 未启用且模型不支持原生多模态时，
  // 把粘贴的 data URL 图片解码落盘到会话图片目录，并在文本末尾追加 <images> XML
  // （标注本地路径与编号），供 ReadImage 工具按路径读取
  private preparePromptImages(sessionId: string, prompt: UserPromptContent): UserPromptContent {
    if (this.getDeepSeekFilesSettings().enabled) {
      return prompt;
    }
    if (supportsMultimodal(this.getResolvedSettings().model, this.getResolvedSettings().multimodal)) {
      return prompt;
    }

    const imageUrls = prompt.imageUrls?.filter(Boolean) ?? [];
    if (imageUrls.length === 0) {
      return prompt;
    }

    const images = imageUrls.map((dataUrl, index) => this.decodePersistedPromptImage(dataUrl, index));
    const imagesDir = this.getSessionImagesDir(sessionId);
    const createdPaths: string[] = [];
    try {
      fs.mkdirSync(imagesDir, { recursive: true });
      for (const image of images) {
        const imagePath = path.join(imagesDir, `${crypto.randomUUID()}${image.extension}`);
        fs.writeFileSync(imagePath, image.buffer, { flag: "wx", mode: 0o600 });
        createdPaths.push(imagePath);
      }
    } catch (error) {
      // 写盘失败时回滚本次已创建的图片文件（尽力而为），保留历史会话的图片目录
      for (const imagePath of createdPaths) {
        try {
          fs.unlinkSync(imagePath);
        } catch {
          // Best-effort rollback of this submission only.
        }
      }
      try {
        fs.rmdirSync(imagesDir);
      } catch {
        // Preserve directories containing images from earlier prompts.
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to save pasted image: ${message}`);
    }

    // 以 XML 形式把图片路径注入 prompt 文本（ReadImage 工具按 name/path 读取）
    const imageXml = [
      "<images>",
      ...createdPaths.map((imagePath, index) => `  <image name="[Image #${index + 1}]" path="${imagePath}" />`),
      "</images>",
    ].join("\n");
    const text = prompt.text?.trimEnd() ?? "";
    return {
      ...prompt,
      text: text ? `${text}\n\n${imageXml}` : imageXml,
    };
  }

  // 上游 v0.3.1：解码 data URL 图片（仅支持 JPEG/PNG/WebP），返回二进制与扩展名
  private decodePersistedPromptImage(dataUrl: string, index: number): PersistedPromptImage {
    const match = /^data:(image\/(?:jpeg|jpg|png|webp));base64,([A-Za-z0-9+/=\r\n]+)$/i.exec(dataUrl);
    if (!match) {
      throw new Error(`Image #${index + 1} is invalid or unsupported. Only JPEG, PNG, and WebP are supported.`);
    }

    const payload = match[2].replace(/[\r\n]/g, "");
    const buffer = Buffer.from(payload, "base64");
    const mimeType = match[1].toLowerCase();
    const extension = mimeType === "image/png" ? ".png" : mimeType === "image/webp" ? ".webp" : ".jpg";
    return { buffer, extension };
  }

  // 上游 v0.3.1：会话分叉时复制源会话引用的图片到目标会话目录，
  // 并把消息中的源图片路径替换为目标路径（forkSession 依赖）
  private copySessionImagesForFork(
    sourceSessionId: string,
    targetSessionId: string,
    messages: SessionMessage[]
  ): SessionMessage[] {
    const sourceDir = this.getSessionImagesDir(sourceSessionId);
    if (!fs.existsSync(sourceDir)) {
      return messages;
    }

    const targetDir = this.getSessionImagesDir(targetSessionId);
    try {
      fs.mkdirSync(path.dirname(targetDir), { recursive: true });
      fs.cpSync(sourceDir, targetDir, { recursive: true, errorOnExist: true });
      return replaceStringValues(messages, sourceDir, targetDir) as SessionMessage[];
    } catch (error) {
      // 复制失败时清理目标目录（避免残留半成品），保留原始错误信息
      try {
        fs.rmSync(targetDir, { recursive: true, force: true });
      } catch {
        // Keep the original copy error.
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to copy session images while forking: ${message}`);
    }
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

  // 上游 v0.3.1：工具执行后续消息（follow-up）构建——工具执行器产出的补充说明消息
  private buildFollowUpMessage(sessionId: string, message: ToolExecutionFollowUpMessage): SessionMessage {
    const now = new Date().toISOString();
    return {
      id: crypto.randomUUID(),
      sessionId,
      role: message.role,
      content: message.content,
      contentParams: message.contentParams ?? null,
      messageParams: null,
      compacted: false,
      visible: message.visible ?? false,
      createTime: now,
      updateTime: now,
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
    toolFunction: unknown | null,
    // 上游 v0.3.1：工具执行结果元数据（可携带 skill 信息，用于技能自动加载标记）
    resultMetadata?: Record<string, unknown>
  ): SessionMessage {
    const now = new Date().toISOString();
    const paramsMd = this.buildToolParamsSnippet(toolFunction);
    const resultMd = this.buildToolResultSnippet(content);
    const isInvisibleExecution = this.isInvisibleExecution(content);
    // 上游 v0.3.1：从结果元数据提取 skill 信息（load_skill 工具执行成功时标记）
    const skill = this.getToolResultSkill(resultMetadata);
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
        skill,
      },
    };
  }

  // 上游 v0.3.1：从工具执行结果元数据中提取并校验 skill 信息（防止非法结构注入 meta）
  private getToolResultSkill(metadata?: Record<string, unknown>): SkillInfo | undefined {
    const skill = metadata?.skill;
    if (!skill || typeof skill !== "object" || Array.isArray(skill)) {
      return undefined;
    }
    const candidate = skill as Partial<SkillInfo>;
    if (
      typeof candidate.name !== "string" ||
      typeof candidate.path !== "string" ||
      typeof candidate.description !== "string"
    ) {
      return undefined;
    }
    return {
      name: candidate.name,
      path: candidate.path,
      description: candidate.description,
      isLoaded: candidate.isLoaded === true ? true : undefined,
      allowImplicitInvocation: candidate.allowImplicitInvocation === false ? false : undefined,
    };
  }

  // 上游 v0.3.1：批量工具执行中按需加载技能（同批次去重——已加载的技能直接短路返回）
  private async loadSkillForToolBatch(
    sessionId: string,
    skillName: string,
    loadedSkillNames: Set<string>
  ): Promise<ToolExecutionResult> {
    if (loadedSkillNames.has(skillName)) {
      return { ok: true, name: "skill", output: `Skill already loaded: ${skillName}.` };
    }
    const result = await this.loadSkillByName(sessionId, skillName);
    if (this.getToolResultSkill(result.metadata)) {
      loadedSkillNames.add(skillName);
    }
    return result;
  }

  private async appendToolMessages(
    sessionId: string,
    toolCalls: unknown[],
    options: {
      permissionOverrides?: UserToolPermission[];
      messagePermissions?: MessageToolPermission[];
    } = {}
  ): Promise<{ waitingForUser: boolean }> {
    // 上游 v0.3.1：记录本批次已加载的技能名（避免同批次重复加载）
    const loadedSkillNames = new Set<string>();
    const hooks: ToolExecutionHooks = {
      onProcessStart: (pid, command) => this.addSessionProcess(sessionId, pid, command),
      onProcessExit: (pid) => this.removeSessionProcess(sessionId, pid),
      onProcessStdout: (pid, chunk) => this.onProcessStdout?.(Number(pid), chunk),
      onProcessTimeoutControl: (pid, control) => this.setSessionProcessTimeoutControl(sessionId, pid, control),
      onBackgroundProcessComplete: (completion) => this.addBackgroundProcessCompletionMessage(sessionId, completion),
      // fork：文件变更检查点经 coordinator 记录（与上游私有方法语义一致，操作同一 file-history 仓库）
      onBeforeFileMutation: (filePath) =>
        this.fileHistoryCoordinator.prepareFileMutationCheckpoint(sessionId, filePath),
      onAfterFileMutation: (filePath) => this.fileHistoryCoordinator.recordFileMutationCheckpoint(sessionId, filePath),
      // 上游 v0.3.1 新增 hooks：插件限流记录 + 批内技能按需加载
      onPluginRateLimitExceeded: (tool) => this.recordPluginRateLimitExceeded(sessionId, tool),
      onLoadSkill: (skillName) => this.loadSkillForToolBatch(sessionId, skillName, loadedSkillNames),
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
      // 上游 v0.3.1：技能加载结果（name === "skill"）携带 metadata，供 buildToolMessage 提取 skill 标记
      const toolMessage = this.buildToolMessage(
        sessionId,
        execution.toolCallId,
        execution.content,
        toolFunction,
        execution.result.name === "skill" ? execution.result.metadata : undefined
      );
      this.appendSessionMessage(sessionId, toolMessage);
      this.onAssistantMessage(toolMessage, true);

      for (const followUpMessage of execution.result.followUpMessages ?? []) {
        // 上游 v0.3.1：follow-up 消息支持任意 role（executor 侧已约束），统一走 buildFollowUpMessage
        followUpMessages.push(this.buildFollowUpMessage(sessionId, followUpMessage));
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

    // 上游 v0.3.1：命中技能列表（用于下方技能目录消息合并）。
    // 采纳上游语义：匹配技能仅记入目录快照（LLM 经 skill 工具按需加载），
    // 不再自动注入技能消息（与 createSession 的语义调整保持一致）
    let matchedSkills: SkillInfo[] = [];
    if (userPrompt.text) {
      const skills = await this.listSkills(sessionId);
      const skillNames = await this.identifyMatchingSkillNames(skills, userPrompt.text, { signal, sessionId });
      this.throwIfAborted(signal);
      const skillSet = new Set(skillNames);
      matchedSkills = skills.filter((skill) => skillSet.has(skill.name));
    }
    userPrompt.skills = await this.normalizeSkills(userPrompt.skills, sessionId);
    this.throwIfAborted(signal);
    this.appendSkillMessages(sessionId, userPrompt.skills);
    // 上游 v0.3.1：追加技能目录消息（合并预加载目录与本次命中技能，去重后输出给 LLM）
    this.appendSkillCatalogMessage(
      sessionId,
      this.mergeSkillCatalog(
        this.listPreloadedSkillCatalog(sessionId),
        matchedSkills.map((skill) => ({ name: skill.name, description: skill.description }))
      )
    );
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
      // 上游 v0.3.1：图片理解工具的参数摘要（显示图片路径）
    } else if (toolName === "UnderstandImage") {
      return typeof args.image_path === "string" ? args.image_path.trim() : "";
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
    // 上游 v0.3.1：ReadImage 路径同样做项目根目录缩略显示（与 read 工具一致）
    if ((toolName === "read" || toolName === "ReadImage") && text.startsWith(this.projectRoot)) {
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

  // 上游 v0.3.1：记录插件限流工具（UnderstandImage/WebSearch 触发限流时标记到会话条目，
  // UI 据此提示降级；已标记 UnderstandImage 时不被 WebSearch 覆盖）
  private recordPluginRateLimitExceeded(sessionId: string, tool: PluginRateLimitedTool): void {
    this.updateSessionEntry(sessionId, (entry) => ({
      ...entry,
      pluginRateLimitedTool: entry.pluginRateLimitedTool === "UnderstandImage" ? entry.pluginRateLimitedTool : tool,
      updateTime: new Date().toISOString(),
    }));
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
      // 上游 v0.3.1：插件限流标记与会话分叉来源（反序列化时做结构校验）
      pluginRateLimitedTool: this.normalizePluginRateLimitedTool(value.pluginRateLimitedTool),
      forkedFrom: this.normalizeForkedFrom(value.forkedFrom),
    };
  }

  // 上游 v0.3.1：插件限流工具字段校验（仅接受 UnderstandImage / WebSearch 两个合法值）
  private normalizePluginRateLimitedTool(value: unknown): PluginRateLimitedTool | undefined {
    return value === "UnderstandImage" || value === "WebSearch" ? value : undefined;
  }

  // 上游 v0.3.1：会话分叉来源字段校验（sessionId/messageId 均须为非空字符串）
  private normalizeForkedFrom(value: unknown): SessionEntry["forkedFrom"] {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return undefined;
    }
    const forkedFrom = value as Record<string, unknown>;
    if (
      typeof forkedFrom.sessionId !== "string" ||
      !forkedFrom.sessionId ||
      typeof forkedFrom.messageId !== "string" ||
      !forkedFrom.messageId
    ) {
      return undefined;
    }
    return {
      sessionId: forkedFrom.sessionId,
      messageId: forkedFrom.messageId,
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
