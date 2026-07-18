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
} from "./eag/tcs";
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
} from "./eag/tcs";

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
} from "./eag/pkc";
export {
  PKC_LAYERS,
  IMPLEMENTED_PKC_LAYERS,
  ENTRY_POINT_TYPES,
  DEFAULT_IGNORED_DIRECTORIES,
  DEFAULT_IGNORED_EXTENSIONS,
} from "./eag/pkc";
export { L1GlobalViewBuilder, L1GlobalViewError } from "./eag/pkc";
export { EntryPointDetector } from "./eag/pkc";
export { TechStackFingerprintExtractor } from "./eag/pkc";
export type {
  PackageJsonParseResult,
  PomXmlParseResult,
  RequirementsTxtParseResult,
  GoModParseResult,
} from "./eag/pkc";

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
} from "./eag/pkc";
export {
  SYMBOL_KINDS,
  DEFAULT_KIND_BOOST,
  DEFAULT_RRF_K,
  DEFAULT_TOP_K,
  FOCUS_POINT_BOOST,
  SMALL_CHANGE_FILE_THRESHOLD,
  SMALL_CHANGE_IMPACTED_THRESHOLD,
} from "./eag/pkc";
export { SemanticSearcher, SemanticSearcherError } from "./eag/pkc";
export { SymbolIndexer, SymbolIndexerError } from "./eag/pkc";
export type { Embedder } from "./eag/pkc";

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
} from "./eag/pkc";
export { BusinessFlowDiscoverer, BusinessFlowDiscovererError } from "./eag/pkc";
export { DatabaseSchemaAnalyzer, DatabaseSchemaAnalyzerError } from "./eag/pkc";
export { DataDictionaryExtractor, DataDictionaryExtractorError } from "./eag/pkc";
export { PeripheralSystemAnalyzer, PeripheralSystemAnalyzerError } from "./eag/pkc";

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
} from "./eag/doc-driven";
export {
  DOCUMENT_TYPES,
  DOCUMENT_STATES,
  DOCUMENT_PATHS,
  COMMIT_TYPES,
  DEFAULT_GIT_PROCESS_CONFIG,
  createDefaultGitProcessConfig,
  GitProcessConfigError,
} from "./eag/doc-driven";
export { DocumentStateMachine, DocumentStateMachineError, createInitialDocument } from "./eag/doc-driven";
export { TaskDecomposer, TaskDecompositionError } from "./eag/doc-driven";
export type { DagValidationResult } from "./eag/doc-driven";
export { GitProcessManager, GitProcessError } from "./eag/doc-driven";
export type { PrDescription } from "./eag/doc-driven";
export { buildConstitution, ConstitutionBuilderError } from "./eag/doc-driven";

// plan.md 生成器（EAG-P2 批次 8 新增）
export { PlanGenerator, PlanGeneratorError } from "./eag/doc-driven";
export type { PlanGenerationInput, ModuleSplit, InterfaceContract, DataMigration, RiskItem } from "./eag/doc-driven";

// tasks.md 生成器（EAG-P2 批次 8 新增）
export { TasksGenerator, TasksGeneratorError } from "./eag/doc-driven";
export type { TasksGenerationInput, TaskCard, TaskCardStatus } from "./eag/doc-driven";
export { TASK_CARD_STATUSES } from "./eag/doc-driven";

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
} from "./eag/gate";
export {
  REVIEW_ROLES,
  LOOP_TYPES,
  GATE_IDS,
  G2_MIN_REVIEW_ROLES,
  G2_FULL_REVIEW_ROLES,
  G3_DEVIATION_THRESHOLD,
} from "./eag/gate";
export { GateG1Checker } from "./eag/gate";
export { GateG2Checker } from "./eag/gate";
export { GateG3Checker } from "./eag/gate";
export { GateOrchestrator, GateOrchestratorError } from "./eag/gate";
