/**
 * Workflows 模块统一出口
 *
 * 来源：multi-agent-team skill scripts/dynamic_workflow/
 * 严格遵循 user rules：禁止 mock/占位/简化
 *
 * Dynamic Workflows 子系统：
 *   - pattern-composer: 6 大模式选择器（classifier-dispatch / fan-out-aggregate /
 *     adversarial-verify / generate-filter / tournament / loop-until-done）
 *   - pattern-executor: 模式执行器（Phase 0 完整版：6 大模式全部支持）
 *   - pattern-tier-resolver: 模型分层路由器
 *   - model-router: 模型路由器（Phase 3 移植：基于任务特征 + 画像反哺）
 *   - token-budget-guard: Token 预算防护
 *   - skill-injector: 动态 skill 注入
 *   - interruption-recovery: 中断恢复
 *   - worktree-manager: Git worktree 隔离管理
 *
 * 设计约束（来自 DYNAMIC_WORKFLOWS_INTEGRATION.md）：
 *   - 🔴 模式上限 6：Phase 5 补齐 6 大模式，不再扩展
 *   - 🔴 一阶段一模块：每个组件单一职责，可独立使用
 *   - 🔴 持久化复用：所有反哺统一复用 PerformanceFingerprint
 *   - 🔴 隔离前置：worktree 隔离要求目标环境为 Git 仓库
 */

// ============================================================================
// 模式选择器
// ============================================================================

export {
  defaultTaskFeature,
  taskFeatureToDict,
  patternSelectionToDict,
  selectClassifierDispatch,
  selectFanOutAggregate,
  selectAdversarialVerify,
  selectGenerateFilter,
  selectTournament,
  selectLoopUntilDone,
  PATTERN_CLASSIFIER_DISPATCH,
  PATTERN_FAN_OUT_AGGREGATE,
  PATTERN_ADVERSARIAL_VERIFY,
  PATTERN_GENERATE_FILTER,
  PATTERN_TOURNAMENT,
  PATTERN_LOOP_UNTIL_DONE,
  ALL_PATTERNS,
  PHASE0_PATTERNS,
  validatePattern,
  PatternLibrary,
  PatternComposer,
  createDefaultComposer,
  selectPatternForTask,
} from "./pattern-composer.js";

export type {
  RiskLevel,
  TaskFeature,
  FailureMode,
  WorkflowPattern,
  PatternSelector,
  PatternSelection,
  PerformanceFingerprintLike as ComposerFingerprintLike,
} from "./pattern-composer.js";

// ============================================================================
// 模式执行器
// ============================================================================

export {
  ClassifierDispatchExecutor,
  FanOutAggregateExecutor,
  AdversarialVerifyExecutor,
  GenerateFilterExecutor,
  TournamentExecutor,
  LoopUntilDoneExecutor,
  SequentialExecutor,
  defaultPatternExecutorResult,
  defaultExecutionContext,
  defaultGuardResult,
  detectPromptInjection,
  noopLog,
  DispatchError,
  createDefaultExecutor,
} from "./pattern-executor.js";

export type {
  PatternExecutorResult,
  PatternExecutorKind,
  AggregationStrategy,
  SubTaskResult,
  AggregationResult,
  VerificationRound,
  CandidateItem,
  PkPair,
  StopConditionCheck,
  ExecutionContext,
  PatternExecutorLike,
  ExecutorLogCallback,
  DispatchFn,
  GuardResult,
  GuardDecisionKind,
  FieldSchemaLike,
  PerformanceFingerprintLike as ExecutorFingerprintLike,
} from "./pattern-executor.js";

// ============================================================================
// 模型分层路由器
// ============================================================================

export {
  PatternTierResolver,
  PatternTierPolicyError,
  InvalidTierError,
  defaultTierResolution,
  defaultTier,
  resolveTier,
  isValidTier,
} from "./pattern-tier-resolver.js";

export type {
  ModelTier as TierModelTier,
  TierTaskFeature,
  PatternTierPolicy,
  TierResolution,
} from "./pattern-tier-resolver.js";

// ============================================================================
// 模型路由器（Model Router）
// ============================================================================

export {
  ModelRouter,
  ModelRouterError,
  InvalidTaskFeatureError,
  ModelTierNotFoundError,
  modelTierFromStr,
  validateModelProfile,
  createModelProfile,
  validateTaskFeature,
  validateRoutingDecision,
  createRoutingDecision,
  routingDecisionToDict,
  defaultTaskFeature as defaultModelRouterTaskFeature,
  ALL_MODEL_TIERS,
  ModelTierValues,
  DEFAULT_PROFILES,
  HIGH_COMPLEXITY_THRESHOLD,
  BUDGET_EXHAUSTED_THRESHOLD,
  TIGHT_DEADLINE_MS,
  MIN_FINGERPRINT_SAMPLES,
  FINGERPRINT_HISTORY_WEIGHT,
  STATIC_RULE_WEIGHT,
  MAX_DECISION_HISTORY,
} from "./model-router.js";

export type {
  ModelTier,
  ModelProfile,
  TaskFeature as ModelRouterTaskFeature,
  RoutingDecision,
  PerformanceFingerprintLike,
  FingerprintRecord,
} from "./model-router.js";

// ============================================================================
// Token 预算防护
// ============================================================================

export {
  TokenBudgetGuard,
  TokenBudgetGuardError,
  TokenBudgetExceeded,
  InvalidBudgetError,
  defaultBudgetSnapshot,
  budgetModeFromStr,
  validateTokenBudget,
  consumptionRatio,
  snapshot,
  createDefaultBudgetGuard,
} from "./token-budget-guard.js";

export type {
  TokenBudget,
  BudgetSnapshot,
  BudgetDecision,
  BudgetDecisionRecord,
  BudgetEnforcementMode,
  BudgetRecommendation,
  TokenBudgetGuardConfig,
} from "./token-budget-guard.js";

// ============================================================================
// Skill 动态注入
// ============================================================================

export { SkillInjector, defaultInjectResult, createDefaultInjector } from "./skill-injector.js";

export type { InjectedSkill, InjectResult, SkillInjectorConfig } from "./skill-injector.js";

// ============================================================================
// 中断恢复
// ============================================================================

export {
  InterruptionRecovery,
  InterruptionRecoveryError,
  CheckpointCorruptedError,
  defaultRecoveryState,
  createDefaultRecovery,
} from "./interruption-recovery.js";

export type { Checkpoint, RecoveryState, RecoveryStrategy } from "./interruption-recovery.js";

// ============================================================================
// 语义 Embedder（Semantic Embedder）
// ============================================================================

export {
  TFIDFEmbedder,
  HashingEmbedder,
  SentenceTransformerEmbedder,
  EmbeddingCache,
  cosineSimilarity,
  tokenize,
  setSemanticLogCallback,
  defaultSemanticLog,
  getDefaultEmbedder,
  resetDefaultEmbedder,
  createEmbedder,
} from "./semantic-embedder.js";

export type {
  EmbedderLike,
  TFIDFEmbedderConfig,
  HashingEmbedderConfig,
  SentenceTransformerEmbedderConfig,
  SentenceTransformerDelegate,
  EmbeddingCacheConfig,
  SemanticLogCallback,
} from "./semantic-embedder.js";

// ============================================================================
// Subagent Sandbox
// ============================================================================

export {
  SubagentSandbox,
  SandboxError,
  GuardRejectError,
  TokenBudgetExceededSandbox,
  SandboxNotFoundError,
  SandboxAlreadyExistsError,
  SandboxTimeoutError,
  UserAbortError,
  PauseRequestError,
  SandboxStatus,
  ALL_SANDBOX_STATUSES,
  IsolationLevel,
  ALL_ISOLATION_LEVELS,
  isValidIsolationLevel,
  createSandboxContext,
  recordToken,
  sandboxResultToDict,
  createNoopGuard,
  defaultSandboxLog,
} from "./subagent-sandbox.js";

export type {
  SandboxContext,
  SandboxResult,
  SubagentSandboxConfig,
  SandboxExecutor,
  SandboxLogCallback,
  GuardResultLike,
  GuardLike,
  SandboxFingerprintLike,
  FingerprintRecordLike,
  SkillInjectorLike,
  SkillInjectionResultLike,
  InterruptionRecoveryManagerLike,
  RetryPolicyLike,
  IsolationLevelType,
  SandboxStatusType,
} from "./subagent-sandbox.js";

// ============================================================================
// Worktree 隔离管理
// ============================================================================

export {
  WorktreeManager,
  WorktreeManagerError,
  NotGitRepoError,
  WorktreeCreateError,
  defaultWorktree,
  createDefaultWorktreeManager,
} from "./worktree-manager.js";

export type { WorktreeInfo, WorktreeStatus, WorktreeManagerConfig } from "./worktree-manager.js";
