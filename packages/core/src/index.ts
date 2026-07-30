// ============================================================================
// Core library API — used by both CLI and VSCode companion.
// ============================================================================
// API 稳定性分级（详见 docs/dev/review.md MEDIUM-2）：
//
// @public       — 稳定 API，对外契约，breaking change 需 semver major
//                 包含：Settings / SessionManager / Providers / Tools / Common
//
// @internal     — 内部 API，可能变更，不建议外部直接使用
//                 包含：StreamAggregator / SkillManager / UsageTracker
//
// @experimental — 实验性 API，不保证兼容，CLI 层未默认启用
//                 包含：EAG orchestrator / InterruptQueue / TaskRegistry / BackgroundTaskRunner
//                 详见 docs/dev/ADR-EAG-001-experimental-status.md
// ============================================================================

// === @public API ===

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
// AskUserQuestion suggestedCommand 类型（供 CLI 层 ask-user-question.ts 共享同构类型）
export type { SuggestedCommand } from "./tools/ask-user-question-handler";

// ============================================================================
// ADR-DI-001 动态指令注入与后台子 Agent 模块（interrupts）
//
// 设计目的：
//   - 将 interrupts 模块（中断队列 / 后台任务 / 任务注册表 / 4 个 LLM 工具）
//     通过 core 单入口暴露给 CLI 层与 VSCode companion
//   - CLI 层（App.tsx / session.ts）通过 `@vegamo/deepcode-core` 导入
//     registerInterruptTools / InterruptibleSessionManager 等
//   - interrupts/index.ts → core/index.ts 二级 re-export 链路
//
// 导出范围：
//   - 数据类型：TaskStatus / TaskKind / InjectedInstruction / TaskStats / TaskSnapshot / TaskListFilter
//   - 错误类：QueueOverflowError / TaskLimitExceededError / InvalidStateTransitionError / InjectInterruptError
//   - 工具常量：BACKGROUND_TASK_TOOL_NAME / LIST_TASKS_TOOL_NAME / CANCEL_TASK_TOOL_NAME / INJECT_MESSAGE_TOOL_NAME
//   - LLM 工具：registerInterruptTools / InterruptToolRegistry / createInterruptToolHandlers
//   - 工具定义：INTERRUPT_TOOL_DEFINITIONS / INTERRUPT_TOOL_METADATA
//   - handler 工厂：createBackgroundTaskHandler / createListTasksHandler / createCancelTaskHandler / createInjectMessageHandler
//   - 抽象接口：InterruptibleSessionManager / BackgroundTaskLike / TaskRegistryLike / BackgroundRunnerLike /
//             InterruptToolHandlerContext / InterruptToolMetadata / InterruptToolDefinition / ToolExecutorRegistrar
//   - 实现类：InterruptQueue / BackgroundTask / TaskRegistry / BackgroundTaskRunner
//   - 实现类 Options 类型：BackgroundTaskOptions / TaskRegistryOptions / BackgroundTaskRunnerOptions /
//                       SessionHandle / SessionManagerFactory / SharedSessionOptions / TaskStoreLike
// ============================================================================

// 共享类型与错误类
export type {
  InjectSource,
  InjectedInstruction,
  InterruptQueueOptions,
  TaskKind,
  TaskListFilter,
  TaskSnapshot,
  TaskStats,
  TaskStatus,
} from "./interrupts/types";
export {
  BACKGROUND_TASK_TOOL_NAME,
  CANCEL_TASK_TOOL_NAME,
  INJECT_MESSAGE_TOOL_NAME,
  InjectInterruptError,
  InvalidStateTransitionError,
  LIST_TASKS_TOOL_NAME,
  QueueOverflowError,
  TaskLimitExceededError,
} from "./interrupts/types";

// LLM 工具定义、handler 工厂与抽象接口
export {
  INTERRUPT_TOOL_DEFINITIONS,
  INTERRUPT_TOOL_METADATA,
  createBackgroundTaskHandler,
  createCancelTaskHandler,
  createInjectMessageHandler,
  createListTasksHandler,
} from "./interrupts/llm-tools";
export type {
  BackgroundRunnerLike,
  BackgroundTaskLike,
  InterruptToolDefinition,
  InterruptToolHandlerContext,
  InterruptToolMetadata,
  InterruptibleSessionManager,
  TaskRegistryLike,
  ToolExecutorRegistrar,
} from "./interrupts/llm-tools";

// 工具注册入口
export {
  InterruptToolRegistry,
  createInterruptToolHandlers,
  registerInterruptTools,
} from "./interrupts/register-tools";

// 实现类（供 SessionManager 类型导入与运行期注入，ADR-DI-001 §7.1 E1 扩展点）
// @experimental — 中断与后台任务能力，CLI 层未默认注入，详见 docs/dev/ADR-EAG-001-experimental-status.md
export { InterruptQueue } from "./interrupts/interrupt-queue";
export { BackgroundTask } from "./interrupts/background-task";
export type { BackgroundTaskOptions } from "./interrupts/background-task";
export { TaskRegistry } from "./interrupts/task-registry";
export type { TaskRegistryOptions } from "./interrupts/task-registry";
export { BackgroundTaskRunner } from "./interrupts/background-runner";
export type {
  BackgroundTaskRunnerOptions,
  SessionHandle,
  SessionManagerFactory,
  SharedSessionOptions,
  TaskStoreLike,
} from "./interrupts/background-runner";

// P1-T2：Visualization 模块 —— PureShowWidget 工具与渲染器
// 提供 LLM 调用 pure_show_widget(widget_code, widget_type) 渲染内联可视化 widget 的能力，
// 由 dynamic-ui skill 驱动；生成的自包含 HTML 写入 .deepcodex/widgets/，由 CLI MessageView 提示用户打开。
export { handlePureShowWidget, pureShowWidgetToolDefinition } from "./visualization/widget-tool";
export { renderWidget, saveWidget, isValidWidgetType } from "./visualization/renderer";
export type { WidgetType, RenderWidgetResult } from "./visualization/renderer";

// MCP
export { McpManager } from "./mcp/mcp-manager";
export { McpClient } from "./mcp/mcp-client";
export type { McpServerStatus } from "./mcp/mcp-manager";

// Common utilities
export { createOpenAIClient } from "./common/openai-client";
// v1.6 P0-2：OpenAIClientHandle 接口与类型守卫（team-adapter.executeDispatch 注入用）
export { isOpenAIClientHandle } from "./common/openai-client";
export type { OpenAIClientHandle } from "./common/openai-client";
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
export { describeLlmError, getLlmErrorDetails } from "./common/llm-error";
export type { LlmErrorDetails } from "./common/llm-error";
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

// ============================================================================
// EAG (Enterprise App Generation) module —— 企业级应用生成能力
// ============================================================================
// @experimental
// 重要提示：以下 EAG 相关 export 均为实验性 API，CLI 层未默认注入。
// - 已启用：EagDynamicSuggester（动态建议）、EagCommandParser（命令解析）
// - 未启用：所有 EAG orchestrator（CodingOrchestrator/TestingOrchestrator/DesignLoopOrchestrator/
//   DevOpsOrchestrator/AutonomousOrchestrator/GraphLoopOrchestrator）及 InterruptQueue/
//   TaskRegistry/BackgroundTaskRunner
// 启用方式详见 docs/dev/ADR-EAG-001-experimental-status.md
// ============================================================================

// EAG 统一命名空间导出（repair-plan.md §3.2）
// - Eag：包含 eag/index.ts 聚合的全部公共 API（evaluator / redlines / loop / coding /
//   testing / long-horizon / devops / dynamic / p5 等），供 CLI 层通过
//   `import { Eag } from "@vegamo/deepcode-core"` 一次性访问全部 EAG 能力。
// - EagP5：p5 子系统的独立命名空间，供需要直接使用符号图谱 / BLOCKER 守护链 /
//   AutonomousOrchestrator 的消费者使用。
// 命名空间导出与下方零散具名导出共存，保持向后兼容。
export * as Eag from "./eag/index.js";
export * as EagP5 from "./eag/p5/index.js";

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

// RLIS (Rule Learning & Injection System) —— §5.5 三层规则存储 + 规则学习与注入
export {
  SEED_RULES,
  getSeedRuleCount,
  getSeedRulesBySeverity,
  getSeedRulesByCategory,
  getSeedRuleById,
} from "./eag/rlis/seed-rules";
export { RuleStore, SEVERITY_UPGRADE_VIOLATION_THRESHOLD, CLEANUP_USAGE_THRESHOLD } from "./eag/rlis/rule-store";
export { RuleInjector, TOKEN_ESTIMATE_RATIO } from "./eag/rlis/rule-injector";
export {
  RuleLearner,
  CORRECTION_PATTERNS,
  CATEGORY_KEYWORDS,
  SEVERITY_KEYWORDS,
  CONFIRMATION_PUSH_THRESHOLD,
  DEFAULT_CATEGORY,
  DEFAULT_SEVERITY,
} from "./eag/rlis/rule-learner";
export type {
  RuleCategory,
  RuleSeverity,
  RuleSource,
  RuleConfirmedBy,
  UserRule,
  RuleCandidate,
  RuleStoreLayer,
  RuleStoreSnapshot,
  RuleInjectionConfig,
} from "./eag/rlis/types";
export {
  RULE_CATEGORIES,
  RULE_SEVERITIES,
  RULE_SOURCES,
  RULE_CONFIRMED_BY,
  RULE_STORE_LAYERS,
  SEVERITY_PRIORITY,
  compareSeverity,
} from "./eag/rlis/types";

// Discovery (Brownfield) —— §6.2 棕地场景：既有系统增量改造
export { BrownfieldDiscovery, REQUIREMENT_KEYWORD_MAPPING } from "./eag/discovery/brownfield-discovery";
export { ChangeClassifier } from "./eag/discovery/change-classifier";
export { ExistingContractGuard } from "./eag/discovery/existing-contract-guard";
export type { ParadigmName } from "./eag/discovery/existing-contract-guard";
export type {
  ChangeType,
  ExistingModelSnapshot,
  IncrementalChange,
  IncrementalDesignResult,
  ContractViolation,
  ContractViolationType,
  TechDebtReport,
} from "./eag/discovery/types";
export { CHANGE_TYPES, CONTRACT_VIOLATION_TYPES } from "./eag/discovery/types";

// TCS (Technical Component Specification) —— §5.8 企业技术组件规范包
// 5 个技术组件（对象存储 / 缓存 / SQL 优化 / LDAP 接入 / 漏洞扫描）+ 13 条红线 + 26 个 fixture
export type {
  // 基础类型
  TcsRedlineId,
  TcsRedlineCategory,
  StorageProvider,
  CacheTier,
  SqlQueryType,
  LdapSyncMode,
  LdapDegradationStrategy,
  VulnerabilitySeverity,
  VulnerabilityScanLayer,
  FixtureKind,
  // 对象存储类型
  ObjectStorageConfig,
  StorageKeyParams,
  PutOptions,
  PutResult,
  GetResult,
  DeleteResult,
  SignedUrlResult,
  MultipartUploadSession,
  MultipartOptions,
  MultipartResult,
  // 缓存类型
  CacheKeyParams,
  CacheSetOptions,
  CacheGetResult,
  CacheMutexResult,
  CacheDoubleWriteResult,
  // SQL 优化类型
  IndexReviewInput,
  IndexDefinition,
  ModelFieldDefinition,
  IndexReviewResult,
  NPlusOneDetectionResult,
  PaginationCheckResult,
  // LDAP 类型
  LdapConfig,
  LdapUserEntry,
  LdapOrgEntry,
  LdapSyncResult,
  LdapSyncState,
  // 漏洞扫描类型
  VulnerabilityFinding,
  VulnerabilityScanReport,
  VulnerabilityScanResult,
  VulnerabilityFixWorkItem,
  ComplianceCheckResult,
  // fixture 类型
  RedlineFixture,
  // Port 抽象接口
  HttpResponse,
  StorageHttpClient,
  ObjectStoragePort,
  RedisClient,
  CacheSerializer,
  CachePort,
  SqlOptimizationPort,
  LdapClient,
  UserMirrorStore,
  LdapSyncPort,
  ScannerAdapter,
  VulnerabilityScanPort,
  // 统计类型
  TcsRedlineStats,
} from "./eag/tcs/index";
export {
  // 基础常量
  TCS_REDLINE_IDS,
  TCS_REDLINE_CATEGORIES,
  STORAGE_PROVIDERS,
  CACHE_TIERS,
  LDAP_SYNC_MODES,
  VULNERABILITY_SEVERITIES,
  VULNERABILITY_SCAN_LAYERS,
  deepFreeze,
  // 对象存储
  DEFAULT_SIGNED_URL_EXPIRY_SECONDS,
  MAX_SIGNED_URL_EXPIRY_SECONDS,
  DEFAULT_MULTIPART_THRESHOLD_BYTES,
  DEFAULT_PART_SIZE_BYTES,
  DEFAULT_MAX_FILE_BYTES,
  generateStorageKey,
  generateUuidV4,
  validateFileExtension,
  validateFileSize,
  validateSignedUrlExpiry,
  signAwsSigV4,
  signOssV1,
  S3Adapter,
  OssAdapter,
  MinioAdapter,
  createObjectStorage,
  // 多级缓存
  DEFAULT_LOCAL_TTL_SECONDS,
  DEFAULT_REDIS_TTL_SECONDS,
  DEFAULT_TTL_JITTER_RATIO,
  DEFAULT_MUTEX_EXPIRY_SECONDS,
  DEFAULT_NULL_CACHE_TTL_SECONDS,
  DEFAULT_BLOOM_EXPECTED_ITEMS,
  DEFAULT_BLOOM_FALSE_POSITIVE_RATE,
  JsonCacheSerializer,
  BloomFilter,
  generateCacheKey,
  generateMutexKey,
  computeJitteredTtl,
  MultiLevelCache,
  createCache,
  // SQL 优化器
  DEEP_PAGINATION_THRESHOLD,
  QUERY_CALL_KEYWORDS,
  LOOP_KEYWORDS,
  MIN_DETECTION_CONFIDENCE,
  IndexReviewer,
  NPlusOneDetector,
  PaginationChecker,
  SqlOptimizer,
  createSqlOptimizer,
  // LDAP 同步器
  DEFAULT_SYNC_BATCH_SIZE,
  DEFAULT_FULL_SYNC_INTERVAL_SECONDS,
  DEFAULT_INCREMENTAL_CACHE_TTL_SECONDS,
  DEFAULT_DEGRADATION_STRATEGY,
  DEFAULT_LDAP_FAILURE_THRESHOLD,
  LdapSynchronizer,
  createLdapSynchronizer,
  // 漏洞扫描器
  HIGH_RISK_CVSS_THRESHOLD,
  DEFAULT_SCAN_TIMEOUT_MS,
  SEVERITY_TO_FIX_PRIORITY,
  VulnerabilityScanner,
  createVulnerabilityScanner,
  // TCS 红线清单
  TCS_REDLINES,
  getTcsRedlineCount,
  getTcsRedlinesBySeverity,
  getTcsRedlineById,
  getTcsRedlinesByCategory,
  isValidTcsRedlineId,
  isValidTcsRedlineCategory,
  getTcsRedlineStats,
  // TCS 红线 fixtures 样例库
  TCS_FIXTURES,
  OSS_FIXTURES,
  CACHE_FIXTURES,
  SQL_FIXTURES,
  LDAP_FIXTURES,
  SECURITY_FIXTURES,
  getFixturesByRedlineId,
  getFixturesByKind,
  getTcsFixtureCount,
  validateTcsFixtures,
} from "./eag/tcs/index";

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

// ============================================================================
// Autonomous 模块 re-export（v1.6 P0-1.4 新增）
//
// 设计目的：
//   - 将 autonomous 模块（Ralph 风格自主迭代主循环）通过 core 单入口暴露
//   - CLI 层（team-cmd.ts）通过 `@vegamo/deepcode-core` 导入 RalphLoopController 等
//   - autonomous/index.ts → team/index.ts → core/index.ts 三级 re-export 链路
//
// 注意：
//   - autonomous 版 `RiskLevel` 已在 team/index.ts 中排除（与 cybernetics 版冲突）
//   - 此处从 `./team/index.js` re-export，保持链路一致
// ============================================================================

// 配置加载
export {
  defaultAutonomousConfig,
  userConfigPath,
  projectConfigPath,
  parseSimpleYaml,
  loadAutonomousConfig,
} from "./team/index.js";
export type { AutonomousConfig } from "./team/index.js";

// 运行状态
export { RunState, listRuns, findLatestResumableRun } from "./team/index.js";
export type { RunStateSchema, ResumeContext } from "./team/index.js";

// Notes 记忆
export { NotesMemory } from "./team/index.js";
export type { NotesSection } from "./team/index.js";

// Loop 控制器
export { RalphLoopController, defaultLoopConfig, defaultIterationResult, generateRunId } from "./team/index.js";
export type {
  StageKind,
  IterationKind,
  LoopConfig,
  IterationContext,
  IterationResult,
  StageResult,
  StageHandler,
  RunStateLike,
  GitDriverLike,
  SleepGuardLike,
  LogCallback,
} from "./team/index.js";

// Git 操作
export { GitDriver, defaultGitOpResult, defaultDiffStats } from "./team/index.js";
export type { GitOpResult, DiffStats } from "./team/index.js";

// Sleep 防护
export { SleepGuard } from "./team/index.js";
export type { SleepGuardMode, SleepGuardBackend, SleepGuardHandle, SleepGuardLogCallback } from "./team/index.js";

// 智能确认（RiskLevel 已在 team/index.ts 排除，避免与 cybernetics 版冲突）
export { SmartConfirmation, scoreToLevel } from "./team/index.js";
export type { ConfirmationDecision, ConfirmationResult } from "./team/index.js";

// 自动 skill 加载
export { AutoSkillLoader, defaultSkillManifest } from "./team/index.js";
export type { SkillManifest } from "./team/index.js";

// Dispatcher 适配层
export { DispatcherAdapter, defaultAdapterInvokeResult, defaultTaskArgs } from "./team/index.js";
export type {
  AdapterInvokeKind,
  AdapterInvokeResult,
  DispatcherTaskArgs,
  FacadeLike,
  AdapterLogCallback,
} from "./team/index.js";

// Stage Handlers（4 个具体实现 + 1 个工厂函数）
export {
  PlanStageHandler,
  DevStageHandler,
  VerifyStageHandler,
  FixStageHandler,
  createDefaultStageHandlers,
} from "./team/index.js";

// ============================================================================
// v2.1 P5：八阶段工作流循环控制器 + 文档对照代码审查器
//
// 以下导出用于 team-cmd.ts 的 full-lifecycle 子命令：
//   - WorkflowLoopController：循环模式控制器（--use-loop 启用）
//   - DefaultStageExecutor：默认阶段执行器（调用 executeDispatch）
//   - DocCodeConsistencyChecker：文档对照一致性检查器（D1~D6 六大维度）
//   - WORKFLOW_STAGES / WorkflowStage：八阶段定义
//   - summarizeWorkflowRunResult：运行结果汇总
// ============================================================================
export {
  WorkflowStage,
  WORKFLOW_STAGES,
  findStage,
  findStageByNumber,
  getStageNumber,
  getRoleName,
  getOutputName,
  toStageKind,
  RollbackStrategy,
  WorkflowLoopController,
  DefaultStageExecutor,
  summarizeWorkflowRunResult,
} from "./team/index.js";
export type {
  WorkflowStageMeta,
  StageExecutionResult,
  WorkflowIterationRecord,
  WorkflowRunResult,
  StageExecutionContext,
  StageExecutor,
  WorkflowLogCallback,
  DefaultStageExecutorOptions,
} from "./team/index.js";

// 文档对照一致性检查器（D1~D6 六大维度）
export { DocCodeConsistencyChecker, DocParser, CodeScanner } from "./team/index.js";
export type {
  FeatureCheckItem,
  IntegrationCheckItem,
  TestCheckResult,
  AcceptanceCheckItem,
  TodoItem,
  DeviationItem,
  GapItem,
  ConsistencyReport,
  CodeSymbol,
  ImportRelation,
  ParsedFeature,
  ParsedAcceptanceCriteria,
  ParsedIntegrationRelation,
  DocPaths,
} from "./team/index.js";

// ============================================================================
// PKC (Project Knowledge Context) —— §5.11 项目知识上下文层
// EAG-P1 批次 5 实施 L1 全局视野层；EAG-P2 批次 8 新增 L2 语义检索 + L3 业务知识
// ============================================================================

// PKC L1 全局视野层（types / l1-global-view / entry-point-detector / tech-stack-fingerprint）
export type {
  PkcLayer,
  RepositoryMap,
  DirectoryNode,
  FileNode,
  EntryPoint,
  EntryPointType,
  TechStackFingerprint,
  LayeredArchitecture,
  LayeredArchitectureParadigm,
  L1GlobalView,
} from "./eag/pkc/index";
export {
  PKC_LAYERS,
  IMPLEMENTED_PKC_LAYERS,
  ENTRY_POINT_TYPES,
  DEFAULT_IGNORED_DIRECTORIES,
  DEFAULT_IGNORED_EXTENSIONS,
} from "./eag/pkc/index";
export { L1GlobalViewBuilder, L1GlobalViewError } from "./eag/pkc/index";
export { EntryPointDetector } from "./eag/pkc/index";
export { TechStackFingerprintExtractor } from "./eag/pkc/index";
export type {
  PackageJsonParseResult,
  PomXmlParseResult,
  RequirementsTxtParseResult,
  GoModParseResult,
} from "./eag/pkc/index";

// PKC L2 语义检索层（l2-types / semantic-searcher / symbol-indexer）—— EAG-P2 批次 8 新增
export type {
  SymbolKind,
  IndexedSymbol,
  SearchOptions,
  SearchResult,
  GitDiffType,
  GitDiffFile,
  GitDiff,
  ReindexResult,
} from "./eag/pkc/index";
export {
  SYMBOL_KINDS,
  DEFAULT_KIND_BOOST,
  DEFAULT_RRF_K,
  DEFAULT_TOP_K,
  FOCUS_POINT_BOOST,
  SMALL_CHANGE_FILE_THRESHOLD,
  SMALL_CHANGE_IMPACTED_THRESHOLD,
} from "./eag/pkc/index";
export { SemanticSearcher, SemanticSearcherError } from "./eag/pkc/index";
export { SymbolIndexer, SymbolIndexerError } from "./eag/pkc/index";
export type { Embedder } from "./eag/pkc/index";

// PKC L3 业务知识层（K2 业务流程 / K3 数据库结构 / K4 业务数据 / K5 周边系统）—— EAG-P2 批次 8 新增
export type {
  FlowStep,
  FlowStepType,
  FlowBranch,
  AsyncBoundary,
  StateMachine,
  StateTransition,
  FlowResult,
  StateMachineResult,
  DatabaseTable,
  DatabaseColumn,
  DatabaseIndex,
  DatabaseForeignKey,
  DatabaseMigration,
  TableCodeTrace,
  SchemaAnalysisResult,
  BusinessEnum,
  BusinessEnumValue,
  DictionaryTable,
  FieldSemantics,
  SensitiveField,
  DataDictionary,
  PeripheralDependencyType,
  PeripheralDependency,
  InteractionMatrixEntry,
  ConfigInventoryEntry,
  PeripheralAnalysisResult,
} from "./eag/pkc/index";
export { BusinessFlowDiscoverer, BusinessFlowDiscovererError } from "./eag/pkc/index";
export { DatabaseSchemaAnalyzer, DatabaseSchemaAnalyzerError } from "./eag/pkc/index";
export { DataDictionaryExtractor, DataDictionaryExtractorError } from "./eag/pkc/index";
export { PeripheralSystemAnalyzer, PeripheralSystemAnalyzerError } from "./eag/pkc/index";

// ============================================================================
// Doc-Driven (文档驱动开发 Loop) —— §5.10 文档驱动开发 Loop
// EAG-P1 批次 5 实施三文档契约 + 任务分解 + Git 过程管理；EAG-P2 批次 8 新增 plan/tasks 生成器
// ============================================================================

export type {
  DocumentType,
  DocumentState,
  EagDocument,
  RequirementPriority,
  FunctionalRequirement,
  TaskNode,
  TaskDag,
  CommitType,
  GitProcessConfig,
  ConstitutionInput,
  NonNegotiableItems,
  WorkflowValidationResult,
} from "./eag/doc-driven/index";
export {
  DOCUMENT_TYPES,
  DOCUMENT_STATES,
  DOCUMENT_PATHS,
  COMMIT_TYPES,
  DEFAULT_GIT_PROCESS_CONFIG,
  createDefaultGitProcessConfig,
  GitProcessConfigError,
} from "./eag/doc-driven/index";
export { DocumentStateMachine, DocumentStateMachineError, createInitialDocument } from "./eag/doc-driven/index";
export { TaskDecomposer, TaskDecompositionError } from "./eag/doc-driven/index";
export type { DagValidationResult } from "./eag/doc-driven/index";
export { GitProcessManager, GitProcessError } from "./eag/doc-driven/index";
export type { PrDescription } from "./eag/doc-driven/index";
export { buildConstitution, ConstitutionBuilderError } from "./eag/doc-driven/index";

// plan.md 生成器（EAG-P2 批次 8 新增）
export { PlanGenerator, PlanGeneratorError } from "./eag/doc-driven/index";
export type {
  PlanGenerationInput,
  ModuleSplit,
  InterfaceContract,
  DataMigration,
  RiskItem,
} from "./eag/doc-driven/index";

// tasks.md 生成器（EAG-P2 批次 8 新增）
export { TasksGenerator, TasksGeneratorError } from "./eag/doc-driven/index";
export type { TasksGenerationInput, TaskCard, TaskCardStatus } from "./eag/doc-driven/index";
export { TASK_CARD_STATUSES } from "./eag/doc-driven/index";

// ============================================================================
// Gate (方案先行门禁) —— §5.12.1 方案先行门禁（Spec-First Gate）
// EAG-P2 批次 8 新增：G-1/G-2/G-3 三道门禁 + GateOrchestrator 编排器
// ============================================================================

export type {
  ReviewRole,
  ReviewVerdict,
  ReviewRecord,
  FileChangeType,
  FileChange,
  LoopType,
  GateId,
  GateSeverity,
  GateContext,
  GateResult,
  GateOrchestrationResult,
  GateChecker,
} from "./eag/gate/index";
export {
  REVIEW_ROLES,
  LOOP_TYPES,
  GATE_IDS,
  G2_MIN_REVIEW_ROLES,
  G2_FULL_REVIEW_ROLES,
  G3_DEVIATION_THRESHOLD,
} from "./eag/gate/index";
export { GateG1Checker } from "./eag/gate/index";
export { GateG2Checker } from "./eag/gate/index";
export { GateG3Checker } from "./eag/gate/index";
export { GateOrchestrator, GateOrchestratorError } from "./eag/gate/index";

// ============================================================================
// EAG LLM 动态编排建议层（2026-07-24 新增）
//
// 根据用户自然语言目标，动态识别任务粒度并给出全局命令建议。
// 覆盖 EAG/Team/Rules/slash 全部命令体系，第一阶段只做建议不自动执行。
//
// 公开 API：
// - 类：EagDynamicSuggester
// - 类型：DynamicCommandCategory / DynamicCommandDescriptor / EagCommandKind /
//         EagClarificationOption / EagDynamicSuggestion / EagDynamicSuggesterOptions /
//         EagDynamicContext / EagSuggestionPromptContext
// - 函数：createEagDynamicSuggester / buildEagSuggestionPrompt
export { EagDynamicSuggester, createEagDynamicSuggester } from "./eag/dynamic/eag-dynamic-suggester";
export type {
  DynamicCommandCategory,
  DynamicCommandDescriptor,
  EagCommandKind,
  EagClarificationOption,
  EagDynamicSuggestion,
  EagDynamicSuggesterOptions,
  EagDynamicContext,
} from "./eag/dynamic/eag-dynamic-suggester";
export { buildEagSuggestionPrompt } from "./eag/dynamic/prompts/eag-suggestion-prompt";
export type { EagSuggestionPromptContext } from "./eag/dynamic/prompts/eag-suggestion-prompt";

// ============================================================================
// EAG Graph（Loop-Graph 融合方案 Phase 5）
// ============================================================================
// @experimental
// 导出图级编排器、图生命周期管理器、核心协议、数据模型、工厂函数与实现类，
// 供 CLI 层（App.tsx）装配 GraphLoopOrchestratorOptions 并注入 SessionManager。
// 未注入 graphLoopOrchestratorOptions 时 /eag-graph 命令不可用，主流程零回归。
// ============================================================================

// 图级编排器与生命周期管理器
export { GraphLoopOrchestrator } from "./eag/graph/index.js";
export { GraphLifecycleManager } from "./eag/graph/index.js";

// 核心数据模型类型
export type {
  GraphNodeType,
  PredicateFunction,
  WorkGraph,
  WorkGraphConfig,
  NodeFieldContract,
  GraphNodeDef,
  GraphEdgeDef,
  NodeLoopConfig,
  GraphNodeResult,
  GraphRunReport,
  PredicateRegistry,
  GraphLogger,
  GraphRunContext,
  GraphValidationResult,
  GraphSchedulingAction,
  GraphSchedulingDecision,
  GraphGuardCheckResult,
  GraphGuardRecord,
  GraphRunStatus,
  ExperienceCase,
  RetrySuppressionConfig,
} from "./eag/graph/index.js";

export {
  GRAPH_NODE_TYPES,
  GRAPH_SCHEDULING_ACTIONS,
  DEFAULT_WORK_GRAPH_CONFIG,
  DEFAULT_NODE_LOOP_CONFIG,
  createRetrySuppressionConfig,
} from "./eag/graph/index.js";

// 核心协议接口
export type {
  NodeExecutorProtocol,
  LoopHandoffAdapter,
  EdgeResolverProtocol,
  GraphGuardProtocol,
  GraphSchedulerProtocol,
  ExperienceStoreProtocol,
  GraphLoopOrchestratorOptions,
  NodeExperienceUploader,
  DualLayerContextManagerProtocol,
  GraphDebuggerProtocol,
} from "./eag/graph/index.js";

// 图定义构造器
export type { WorkGraphJson, GraphNodeDefJson, GraphEdgeDefJson } from "./eag/graph/index.js";
export { GraphBuilder } from "./eag/graph/index.js";

// 边解析器、图级护栏、图级调度器、谓词注册表、经验存储
export {
  EdgeResolverImpl,
  createEdgeResolver,
  GraphGuardImpl,
  createGraphGuard,
  GraphSchedulerImpl,
  createGraphScheduler,
  PredicateRegistryImpl,
  createPredicateRegistry,
  ExperienceStoreImpl,
  createExperienceStore,
  computeSimilarity,
} from "./eag/graph/index.js";

// 节点内循环内核
export type { LoopExecutorCallback, LoopEvaluatorCallback, NodeLoopKernelOptions } from "./eag/graph/index.js";
export { NodeLoopKernel } from "./eag/graph/index.js";

// 节点执行器
export type { NodeExecutorImplOptions } from "./eag/graph/index.js";
export { NodeExecutorImpl, createNodeExecutor } from "./eag/graph/index.js";

// 图生命周期相关类型
export type {
  GraphLifecycleState,
  GraphLifecycleManagerProtocol,
  GraphLifecycleStateChangeEvent,
  GraphLifecycleStateChangeListener,
} from "./eag/graph/index.js";

// ============================================================================
// V2 上下文记忆体系（v2.8，V2-P0a/P0b/P1/P2/P3 五阶段全部完成）
//
// 架构师审查建议（2026-07-21）：
//   - 通过 v2/index.ts 中间聚合层 re-export，与 team/index.ts 风格一致
//   - 区分 `export`（值）与 `export type`（类型），.js 扩展名（ESM 约定）
//   - 8 子模块：context / memory / codemap / understanding / diff / approval / integration / observability
//
// 导出范围：白名单导出（仅 public API），避免内部实现泄露
// ============================================================================
export * from "./v2/index.js";
