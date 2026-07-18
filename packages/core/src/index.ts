// Core library public API — used by both CLI and VSCode companion.

// Settings
export {
  resolveCurrentSettings,
  resolveSettings,
  resolveSettingsSources,
  readSettings,
  readProjectSettings,
  writeSettings,
  writeProjectSettings,
  writeModelConfigSelection,
  applyModelConfigSelection,
  modelConfigKey,
  getUserSettingsPath,
  getProjectSettingsPath,
  DEFAULT_MODEL,
  DEFAULT_BASE_URL,
} from "./settings";
export type {
  DeepcodingSettings,
  ResolvedDeepcodingSettings,
  ModelConfigSelection,
  PermissionScope,
  PermissionSettings,
  PermissionDefaultMode,
  McpServerConfig,
  ReasoningEffort,
  StatusLineSettings,
  ResolvedStatusLineSettings,
  StatusLineProviderConfig,
} from "./settings";

// Session
export { SessionManager, getProjectCode, getCompactPromptTokenThreshold } from "./session";
export type {
  SessionMessage,
  SessionEntry,
  SessionStatus,
  SessionsIndex,
  SessionMessageRole,
  MessageMeta,
  UndoTarget,
  UserPromptContent,
  SkillInfo,
  ModelUsage,
  SessionProcessEntry,
  BashTimeoutAdjustment,
  LlmStreamProgress,
} from "./session";

// Provider 抽象层导出（原生 Claude API 支持）
export { ProviderFactory } from "./providers/provider-factory";
export { AnthropicProvider, AnthropicLLMClient } from "./providers/anthropic-provider";
export { OpenAIProvider, OpenAILLMClient } from "./providers/openai-provider";
export { AnthropicMessageConverter } from "./providers/anthropic-converter";
export type {
  LLMClient,
  LLMProvider,
  LLMRequest,
  LLMResponse,
  LLMStreamEvent,
  LLMToolCall,
  LLMToolDefinition,
  LLMUsage,
  ProviderName,
} from "./providers/llm-provider";

// Prompt utilities
export {
  getSystemPrompt,
  getCompactPrompt,
  getRuntimeContext,
  getDefaultSkillPrompt,
  getPlanModePrompt,
  getExtensionRoot,
  getTools,
  buildSkillDocumentsPrompt,
} from "./prompt";
export type { ToolDefinition, SkillPromptDocument } from "./prompt";

// Tools
export { ToolExecutor } from "./tools/executor";
export type {
  CreateOpenAIClient,
  ToolCall,
  ToolExecutionContext,
  ToolExecutionHooks,
  ToolExecutionResult,
  ToolHandler,
  ToolCallExecution,
  ProcessTimeoutInfo,
  ProcessTimeoutControl,
  BackgroundProcessCompletion,
  ToolExecutionFollowUpMessage,
} from "./common/tool-types";

// Tool handlers
export { handleBashTool, clearSessionWorkingDir } from "./tools/bash-handler";
export { handleReadTool } from "./tools/read-handler";
export { handleWriteTool } from "./tools/write-handler";
export { handleEditTool } from "./tools/edit-handler";
export { handleUpdatePlanTool } from "./tools/update-plan-handler";
export { handleWebSearchTool } from "./tools/web-search-handler";
export { handleAskUserQuestionTool } from "./tools/ask-user-question-handler";

// MCP
export { McpManager } from "./mcp/mcp-manager";
export { McpClient } from "./mcp/mcp-client";
export type { McpServerStatus } from "./mcp/mcp-manager";

// Common utilities
export { createOpenAIClient } from "./common/openai-client";
export { buildThinkingRequestOptions } from "./common/openai-thinking";
export { readTextFileWithMetadata, writeTextFile, buildDiffPreview, ensureParentDirectory } from "./common/file-utils";
export { normalizeFilePath, getSnippet, clearSessionState, recordFileState, getFileState } from "./common/state";
export { GitFileHistory } from "./common/file-history";
export { killProcessTree } from "./common/process-tree";
export { launchNotifyScript } from "./common/notify";
export { reportNewPrompt } from "./common/telemetry";
export { DEEPSEEK_V4_MODELS, supportsMultimodal, defaultsToThinkingMode } from "./common/model-capabilities";
export { findGitBashPath, resolveShellPath, setShellIfWindows } from "./common/shell-utils";
export { logApiError } from "./common/error-logger";
export { logOpenAIChatCompletionDebug } from "./common/debug-logger";
export {
  clampBashTimeoutMs,
  DEFAULT_BASH_TIMEOUT_MS,
  BASH_TIMEOUT_INCREMENT_MS,
  BASH_TIMEOUT_DECREMENT_MS,
} from "./common/bash-timeout";
export { executeValidatedTool, semanticBoolean } from "./common/validate";
export { OpenAIMessageConverter } from "./common/openai-message-converter";
export {
  computeToolCallPermissions,
  buildPermissionToolExecution,
  hasUserPermissionReplies,
  appendProjectPermissionAllows,
  normalizeAskPermissions,
  parseToolCallForPermissions,
} from "./common/permissions";
export type {
  AskPermissionRequest,
  AskPermissionScope,
  BashPermissionScope,
  MessageToolPermission,
  PermissionDecision,
  PermissionToolCall,
  UserToolPermission,
} from "./common/permissions";

// State types
export type { FileState, FileSnippet, FileLineEnding } from "./common/state";
export type { FileReadMetadata } from "./common/file-utils";

// Loop Guard —— EAG 与 autonomous 共享上限保护（EAG §5.2.1）
export { DEFAULT_LOOP_GUARD_CONFIG, INITIAL_LOOP_GUARD_STATE, LoopGuard } from "./common/loop-guard";
export type { LoopGuardConfig, LoopGuardState, GuardCheckResult, GuardStopReason } from "./common/loop-guard";

// EAG (Enterprise App Generation) module —— 企业级应用生成能力
// EAG 方案 §5.1~§5.13：Generator/Evaluator 分离 + 共享 LoopGuard + RLIS 规则注入
export { decideVerdict, buildReport } from "./eag/evaluator/types";
export type {
  EvaluationMode,
  RedlineSeverity,
  EvaluationVerdict,
  RedlineDefinition,
  RedlineResult,
  RedlineViolation,
  EvaluationContext,
  EvaluationReport,
  IndependentEvaluator,
} from "./eag/evaluator/types";

// RLIS (Rule Learning & Injection System) —— §5.5 三层规则存储
export { SEED_RULES, getSeedRuleCount, getSeedRulesBySeverity, getSeedRulesForInjection } from "./eag/rlis/seed-rules";
export {
  RuleStore,
  DEFAULT_USER_RULES_PATH,
  DEFAULT_TOKEN_BUDGET,
  RULES_FILE_VERSION,
  getDefaultProjectRulesPath,
  validateRule,
  ruleToRedline,
  estimateTokens,
} from "./eag/rlis/rule-store";
export type {
  RuleSource,
  RuleSeverity,
  InjectionTarget,
  RuleDefinition,
  RuleStorageLayer,
  MergedRuleSet,
} from "./eag/rlis/types";
export type { RuleOperationResult, SystemPromptFormatOptions } from "./eag/rlis/rule-store";

// Team (multi-role) module — DeepCodeX multi-agent team integration
export {
  ROLE_REGISTRY,
  ROLE_MAP,
  getRole,
  getEnabledRoles,
  findCandidatesByKeyword,
  listRoleIds,
  matchRoles,
  matchRolesSync,
  MATCH_WEIGHTS,
  AI_MATCH_WEIGHTS,
  MatchOptions,
  AIRoleMatchRequest,
  AIRoleMatchResponse,
  loadTeamConfig,
  buildTask,
  dispatchToRole,
  dispatchToRoleSync,
  executeDispatch,
  composeSystemPrompt,
  listAllRoles,
  getRoleById,
  formatRoleInfo,
  DispatchOptions,
  ALL_SCHEMAS,
  RoleIdSchema,
  RolePrioritySchema,
  RoleDefinitionSchema,
  TaskRequirementSchema,
  MatchResultSchema,
  DispatchResultSchema,
  PluginNameSchema,
  WorkflowPatternSchema,
  WorkflowStepSchema,
  WorkflowDefinitionSchema,
  AutonomousPhaseSchema,
  AutonomousStateSchema,
  ControlLayerSchema,
  FeedbackSignalSchema,
  UIUXIssueSchema,
  VisualDiffResultSchema,
  TeamConfigSchema,
} from "./team/index.js";
export type {
  RoleId,
  RolePriority,
  RoleCapability,
  RoleSkill,
  RoleKeyword,
  RoleDefinition,
  TaskPriority,
  TaskRequirement,
  ScoreBreakdown,
  MatchResult,
  DispatchStatus,
  DispatchResult,
  PluginName,
  PluginPriority,
  PluginContext,
  GoalCommandPlugin,
  WorkflowPattern,
  WorkflowStep,
  WorkflowDefinition,
  AutonomousPhase,
  AutonomousState,
  ControlLayer,
  FeedbackSignal,
  UIUXSeverity,
  UIUXCategory,
  UIUXIssue,
  ChangedRegion,
  VisualDiffResult,
  MatchStrategy,
  TeamConfig,
  TeamDispatchResult,
} from "./team/index.js";
