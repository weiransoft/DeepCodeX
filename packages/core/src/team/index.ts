/**
 * DeepCodeX 多角色团队模块 - 公共 API
 *
 * 这是 team 模块的唯一对外导出入口
 * 严格遵循 user rules：所有导出必须真实实现，禁止 mock
 * Ponytail 红线 R-15：所有 exported 函数必须 TypeScript 类型签名
 */

// ============================================================================
// 第一部分：类型导出
// ============================================================================

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
  // v1.1 新增：领域专家相关类型
  DomainCategory,
  DomainExpert,
  DomainExpertId,
  DomainExpertMatchResult,
  DomainMatchOptions,
  DomainMatcherOptions,
  ExpertOpinion,
  DomainExpertDispatchResult,
} from "./types.js";

// ============================================================================
// 第二部分：Schema 导出
// ============================================================================

export {
  RoleId as RoleIdSchema,
  RolePriority as RolePrioritySchema,
  RoleDefinition as RoleDefinitionSchema,
  TaskRequirement as TaskRequirementSchema,
  MatchResult as MatchResultSchema,
  DispatchResult as DispatchResultSchema,
  PluginName as PluginNameSchema,
  WorkflowPattern as WorkflowPatternSchema,
  WorkflowStep as WorkflowStepSchema,
  WorkflowDefinition as WorkflowDefinitionSchema,
  AutonomousPhase as AutonomousPhaseSchema,
  AutonomousState as AutonomousStateSchema,
  ControlLayer as ControlLayerSchema,
  FeedbackSignal as FeedbackSignalSchema,
  UIUXIssue as UIUXIssueSchema,
  VisualDiffResult as VisualDiffResultSchema,
  TeamConfig as TeamConfigSchema,
  ALL_SCHEMAS,
} from "./types.js";

// ============================================================================
// 第三部分：错误类型导出
// ============================================================================

export {
  ErrorCode,
  TeamError,
  DropInFileNotFoundError,
  DropInSpecFailedError,
  DropInExecFailedError,
  DropInNoPluginError,
  DropInDuplicateNameError,
  DropInConstructFailedError,
  DropInPathAbsoluteError,
  DropInPathOutsideRootError,
  DropInPathNotDirError,
  DropInPathCreateFailedError,
  DropInPathError,
  PluginNameInvalidError,
  PluginPriorityDuplicateError,
  PluginMutexSelfError,
  PluginMutexUnknownError,
  PluginMutexAsymmetricError,
  PluginNotRegisteredError,
  PluginAlreadyRegisteredError,
  DispatcherCircularDependencyError,
  DispatcherMissingDependencyError,
  DispatcherBatchTimeoutError,
  DispatcherCancelledError,
  ReloadGuardBusyError,
  ReloadPartialFailureError,
  ReloadRollbackFailedError,
  RoleMatchNoResultError,
  RoleMatchInvalidError,
  ConfigInvalidError,
  ConfigFileNotFoundError,
  // v1.1 新增：领域专家错误
  DomainExpertAlreadyRegisteredError,
  DomainExpertRoleIdCollisionError,
  DomainExpertCategoryUnknownError,
  DomainExpertNotFoundError,
  // v1.1 Phase 5 新增：领域专家 review 插件错误
  ExpertInvocationError,
} from "./errors.js";
export type { ErrorInfo } from "./errors.js";

// ============================================================================
// 第四部分：角色注册表
// ============================================================================

export {
  ROLE_REGISTRY,
  ROLE_MAP,
  getRole,
  getEnabledRoles,
  findCandidatesByKeyword,
  listRoleIds,
} from "./role-registry.js";

// ============================================================================
// 第五部分：角色匹配
// ============================================================================

export {
  matchRoles,
  matchRolesSync,
  MATCH_WEIGHTS,
  AI_MATCH_WEIGHTS,
  MatchOptions,
  AIRoleMatchRequest,
  AIRoleMatchResponse,
} from "./role-matcher.js";

// ============================================================================
// 第六部分：适配层
// ============================================================================

export {
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
} from "./team-adapter.js";
export type { TeamDispatchResult } from "./team-adapter.js";

// ============================================================================
// 第七部分：Plugin Context
// ============================================================================

export {
  buildPluginContext,
  ctxInfo,
  ctxWarn,
  ctxError,
  ctxCritical,
  ctxDebug,
  emitEvent,
  getState,
  setState,
  isTimedOut,
  elapsedMs,
  toDispatchResult,
  guardDryRun,
  isCancelled,
  clonePluginContext,
} from "./plugin-context.js";
export type { BuildContextParams, LogLevel as CtxLogLevel, PluginEvent, PluginEventType } from "./plugin-context.js";

// ============================================================================
// 第八部分：Drop-in Loader
// ============================================================================

export { DropInLoader, sanitizeStem } from "./drop-in-loader.js";

// ============================================================================
// 第九部分：Reload Guard
// ============================================================================

export { ReloadGuard, withReloadGuard } from "./reload-guard.js";
export type { GuardState, GuardHolder } from "./reload-guard.js";

// ============================================================================
// 第十部分：Hot Reload Watcher
// ============================================================================

export { HotReloadWatcher, POLL_INTERVAL, sanitizeStem as watcherSanitizeStem } from "./hot-reload-watcher.js";
export type {
  HotReloadWatcherOptions,
  CriticalFailureCallback,
  WatcherLogLevel,
  WatcherLogCallback,
} from "./hot-reload-watcher.js";

// ============================================================================
// 第十一部分：Goal Dispatcher + Plugin 系统
// ============================================================================

export {
  BasePlugin,
  validatePluginContracts,
  GoalDispatcher,
  PluginRegistry,
  GoalInstance,
  GoalBatch,
  DispatcherOptions,
  topologicalLevels,
  makeGoal,
  makeBatch,
  // 7 个内置插件
  AutonomousPlugin,
  MultiGoalPlugin,
  GraphPlugin,
  LoopPlugin,
  ResumePlugin,
  CancelPlugin,
} from "./plugins/index.js";

// ============================================================================
// 第十一部分补充：领域专家 review 插件（v1.1 Phase 5 新增）
// ============================================================================

export { DomainExpertReviewPlugin } from "./domain-expert-review-plugin.js";
export type { DomainExpertReviewPluginOptions } from "./domain-expert-review-plugin.js";

// ============================================================================
// 第十一部分补充2：领域专家注册中心 + 匹配器 + 8 类专家注册（v1.1 Phase 2-4 新增）
// ============================================================================

export { DomainExpertRegistry } from "./domain-expert-registry.js";
export type { RoleRegistryAdapter } from "./domain-expert-registry.js";
export {
  DomainExpertMatcher,
  DOMAIN_MATCH_WEIGHTS,
  DOMAIN_AI_MATCH_WEIGHTS,
  DomainMatchOptionsSchema,
  AIDomainExpertMatchRequest,
  AIDomainExpertMatchResponse,
} from "./domain-expert-matcher.js";
export { registerAllExperts, EXPECTED_TOTAL_EXPERTS, ALL_DOMAIN_CATEGORIES } from "./domain-experts/index.js";

// GoalState, BatchResult 是 type-only，重新导出时需要 export type
export type { GoalState, BatchResult } from "./plugins/index.js";
export type {
  PluginMeta,
  RunStateData,
  AutonomousLoopConfig,
  AutonomousPhaseKind,
  PhaseHandler,
  PhaseResult,
  SubGoalSpec,
  LoopStep,
  ExitPredicate,
  GraphNode,
  Checkpoint,
} from "./plugins/index.js";

// ============================================================================
// 第十二部分：Cybernetics 工程控制论（Phase 1 完整移植）
// ============================================================================

export {
  // Feedback Control Loop
  ControlPhase,
  ALL_CONTROL_PHASES,
  isValidControlPhase,
  FeedbackControlLoopError,
  FeedbackControlStorageError,
  createExecutionCase,
  executionCaseToDict,
  executionCaseFromDict,
  createControlState,
  controlStateSuccessRate,
  controlStateAvgTime,
  touchControlState,
  createFeedback,
  SimpleMutex,
  NodeFileSystem,
  FeedbackCollector,
  StateEstimator,
  STRATEGY_DEFINITIONS,
  ALL_STRATEGIES,
  StrategyPool,
  FeedbackControlLoop,
} from "./cybernetics/feedback-control-loop.js";
export type {
  ExecutionCase,
  ControlState,
  Feedback,
  FileSystemLike,
  StrategyConfig,
  TaskExecutor,
  FeedbackControlLoopConfig,
} from "./cybernetics/feedback-control-loop.js";

export {
  // Guard Coordinator
  RiskLevel,
  ALL_RISK_LEVELS,
  isValidRiskLevel,
  Severity,
  GuardCoordinatorError,
  createValidationWarning,
  validationWarningToDict,
  createCompensationStrategy,
  compensationStrategyToDict,
  createAnomalyPattern,
  monitorResultToDict,
  reviewResultToDict,
  ANOMALY_PATTERN_IDS,
  COMPENSATION_STRATEGY_IDS,
  containsPlaceholderCode,
  containsSpeculativeCode,
  hasClearGoals,
  containsUnverifiedAssumptions,
  GuardCoordinator,
} from "./cybernetics/guard-coordinator.js";
export type {
  ValidationWarning,
  CompensationStrategy,
  ValidationResult,
  AnomalyPattern,
  MonitorResult,
  ReviewResult,
  ValidationRule,
  AIProviderLike,
  AnomalyPatternId,
  CompensationStrategyId,
  CompareOperator,
  TriggerCondition,
  GuardCoordinatorConfig,
} from "./cybernetics/guard-coordinator.js";

export {
  // Hierarchical Control
  ControlLevel,
  ALL_CONTROL_LEVELS,
  isValidControlLevel,
  HierarchicalControlError,
  ROLE_CAPABILITIES,
  ALL_ROLE_IDS,
  createStrategicPlan,
  strategicPlanToDict,
  tacticalDecisionToDict,
  executionMetricsToDict,
  StrategicController,
  TacticalController,
  ExecutionController,
  HierarchicalControlManager,
} from "./cybernetics/hierarchical-control.js";
export type {
  RoleCapabilities,
  RoleConfig,
  StrategicPlan,
  TacticalDecision,
  ExecutionMetrics,
  HierarchicalTaskExecutor,
  FeedbackLoopLike,
} from "./cybernetics/hierarchical-control.js";

export {
  // Karpathy Principle Enforcer
  PrincipleType,
  ALL_PRINCIPLE_TYPES,
  isValidPrincipleType,
  ViolationSeverity,
  SEVERITY_ORDER,
  ALL_VIOLATION_SEVERITIES,
  KarpathyPrincipleEnforcerError,
  VIOLATION_PATTERNS,
  createPrincipleViolation,
  principleViolationToDict,
  createVerificationCheckpoint,
  verificationCheckpointToDict,
  karpathyEnforcementReportToDict,
  KarpathyNodeFileSystem,
  KarpathyPrincipleEnforcer,
  getPrincipleName,
} from "./cybernetics/karpathy-principle-enforcer.js";
export type {
  ViolationPattern,
  PrincipleViolation,
  VerificationCheckpoint,
  KarpathyEnforcementReport,
  KarpathyFileSystemLike,
  KarpathyPrincipleEnforcerConfig,
} from "./cybernetics/karpathy-principle-enforcer.js";

// ============================================================================
// 第十三部分：Principles 原则常量（Karpathy + Ponytail + Quality Gates）
// ============================================================================

export {
  // Karpathy 4 原则
  KARPATHY_PRINCIPLE_IDS,
  ALL_KARPATHY_PRINCIPLES,
  isValidKarpathyPrinciple,
  THINK_BEFORE_CODING,
  SIMPLICITY_FIRST,
  SURGICAL_CHANGES,
  GOAL_DRIVEN_EXECUTION,
  KARPATHY_4_PRINCIPLES_FULL,
  getKarpathyPrinciples,
  getKarpathyPrinciple,
  getKarpathyPrincipleName,
} from "./principles/karpathy.js";
export type { KarpathyPrincipleId } from "./principles/karpathy.js";

export {
  // Ponytail 决策梯
  PonytailMode,
  ALL_PONYTAIL_MODES,
  isValidPonytailMode,
  ponytailModeFromStr,
  PONYTAIL_ROLE_IDS,
  ALL_PONYTAIL_ROLE_IDS,
  isValidPonytailRole,
  ROLE_INTENSITY,
  getRoleIntensity,
  LADDER_BODY,
  RED_LINES,
  RED_LINE_LIST,
  OUTPUT_SPEC,
  ULTRA_EXTRA,
  LITE_EXTRA,
  PonytailRulesetEngine,
  DEFAULT_PONYTAIL_ENGINE,
} from "./principles/ponytail.js";
export type { PonytailModeType, PonytailRoleId } from "./principles/ponytail.js";

export {
  // Quality Gates 质量门禁
  QualityGateId,
  ALL_QUALITY_GATE_IDS,
  isValidQualityGateId,
  GateSeverity,
  GateStatus,
  QualityGateError,
  GateConfigError,
  createQualityGateConfig,
  qualityGateConfigToDict,
  createGateFinding,
  createGateResult,
  createQualityReport,
  DEFAULT_GATE_CONFIGS,
  getDefaultGateConfigs,
  findGateConfig,
  DefaultPassExecutor,
  QualityGateManager,
  DEFAULT_QUALITY_GATE_MANAGER,
} from "./principles/quality-gates.js";
export type {
  QualityGateConfig,
  GateFinding,
  GateResult,
  QualityReport,
  GateExecutorLike,
  GateSeverityType,
  GateStatusType,
  QualityGateIdType,
} from "./principles/quality-gates.js";

// ============================================================================
// 第十四部分：Autonomous 模块完整 re-export（v1.6 P0-1.4 新增）
//
// 设计目的：
//   - 将 autonomous 模块的所有公共 API 通过 team/index.ts 统一对外暴露
//   - CLI 层（team-cmd.ts）通过 `@vegamo/deepcode-core` 单入口导入
//   - 避免 CLI 层直接依赖 autonomous 子模块路径
//
// 注意：
//   - autonomous 版 `RiskLevel` 与 cybernetics 版（第 322 行）重名，
//     此处显式排除 autonomous 版 RiskLevel，保留 cybernetics 版。
//   - 其他名称无冲突，完整 re-export。
// ============================================================================

// 配置加载
export {
  defaultAutonomousConfig,
  userConfigPath,
  projectConfigPath,
  parseSimpleYaml,
  loadAutonomousConfig,
} from "./autonomous/index.js";
export type { AutonomousConfig } from "./autonomous/index.js";

// 运行状态
export { RunState, listRuns, findLatestResumableRun } from "./autonomous/index.js";
export type { RunStateSchema, ResumeContext } from "./autonomous/index.js";

// Notes 记忆
export { NotesMemory } from "./autonomous/index.js";
export type { NotesSection } from "./autonomous/index.js";

// Loop 控制器
export { RalphLoopController, defaultLoopConfig, defaultIterationResult, generateRunId } from "./autonomous/index.js";
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
} from "./autonomous/index.js";

// Git 操作
export { GitDriver, defaultGitOpResult, defaultDiffStats } from "./autonomous/index.js";
export type { GitOpResult, DiffStats } from "./autonomous/index.js";

// Sleep 防护
export { SleepGuard } from "./autonomous/index.js";
export type { SleepGuardMode, SleepGuardBackend, SleepGuardHandle, SleepGuardLogCallback } from "./autonomous/index.js";

// 智能确认（排除 RiskLevel，避免与 cybernetics 版冲突）
export { SmartConfirmation, scoreToLevel } from "./autonomous/index.js";
export type { ConfirmationDecision, ConfirmationResult } from "./autonomous/index.js";

// 自动 skill 加载
export { AutoSkillLoader, defaultSkillManifest } from "./autonomous/index.js";
export type { SkillManifest } from "./autonomous/index.js";

// Dispatcher 适配层
export { DispatcherAdapter, defaultAdapterInvokeResult, defaultTaskArgs } from "./autonomous/index.js";
export type {
  AdapterInvokeKind,
  AdapterInvokeResult,
  DispatcherTaskArgs,
  FacadeLike,
  AdapterLogCallback,
} from "./autonomous/index.js";

// Stage Handlers（4 个具体实现 + 1 个工厂函数）
export {
  PlanStageHandler,
  DevStageHandler,
  VerifyStageHandler,
  FixStageHandler,
  createDefaultStageHandlers,
} from "./autonomous/index.js";
