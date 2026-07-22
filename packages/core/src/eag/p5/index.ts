/**
 * EAG-P5 Phase 5.1/5.2 barrel 导出（TASK-P5-1.1-011 + TASK-P5-1.2-001~010）
 *
 * 本模块是 EAG-P5 子系统的统一入口，对外导出以下六大类符号：
 *
 * 1. 符号图谱存储（Phase 5.1 TASK-P5-1.1-003~005）：
 *    - SymbolGraphStore / EdgeResolver / ImpactBFS
 *    - 类型：SymbolRecord / EdgeRecord / ImpactResult / ImpactPath / GraphStats
 *           / SymbolKind / EdgeKind / EdgeConfidence / ResolvedEdge / ImpactBFSOptions
 *    - 常量：CONFIDENCE_VALUE_MAP / CONFIDENCE_EXTRACTED / CONFIDENCE_AMBIGUOUS / CONFIDENCE_UNRESOLVED
 *    - 工具：isGraphStoreAvailable / computeDepthDecayedWeight / computeEdgeWeight
 *
 * 2. 6 层 15 条 BLOCKER 守护链（Phase 5.2 TASK-P5-5.2-001~007）：
 *    - Guard 类：EnvBoundaryGuard / DangerousCommandGuard / ScopeLockGuard
 *               / FakeCompletionGuard / CredentialMisuseGuard / RuntimeConstraintGuard
 *    - 守护链：BlockerGuardChain / createDefaultBlockerGuardChain
 *    - 类型：GuardLayer / GuardRuleId / GuardSeverity / GuardDecision / GuardContext
 *           / GuardVerdict / GuardRule / GuardChainResult / GuardRecord
 *           / TaskCard / ChangeDiff / ChangedFile / CompletionEvidence
 *           / BlockerGuardChainOptions
 *    - 错误：GuardViolationError
 *    - 工厂：createPassVerdict / createDenyVerdict / createAskVerdict
 *    - 常量：GUARD_LAYER_ORDER / ALL_GUARD_RULE_IDS / RULE_TO_LAYER / RULE_TO_SEVERITY
 *
 * 3. Guard 模块导出的常量（供测试断言）：
 *    - ENV_BOUNDARY_PROTECTED_ENV_VARS / ENV_BOUNDARY_SYSTEM_SENSITIVE_PREFIXES
 *    - ENV_BOUNDARY_PROD_CREDENTIAL_PATTERNS
 *    - DANGEROUS_COMMAND_GUARD_PATTERNS / DANGEROUS_COMMAND_DELETE_PATTERNS
 *    - DANGEROUS_COMMAND_AUTO_ALLOWLIST / DANGEROUS_COMMAND_MAX_BATCH_DELETE_THRESHOLD
 *    - SCOPE_LOCK_CLEANUP_KEYWORDS / CREDENTIAL_MISUSE_FILE_PATTERNS
 *    - CREDENTIAL_MISUSE_GITLEAKS_PATTERNS / FAKE_COMPLETION_STOP_WHEN_ALLOWLIST
 *    - FAKE_COMPLETION_STOP_WHEN_BLACKLIST / RUNTIME_CONSTRAINT_IMMUTABLE_FIELDS
 *    - BLOCKER_GUARD_CHAIN_TIMEOUT_MS
 *
 * 4. RunState 持久化存储（Phase 5.2 TASK-P5-1.2-001）：
 *    - 类：P5RunStateStore
 *    - 工厂：createDefaultP5RunStateStore
 *    - 错误：P5RunStateStoreError / P5RunStateCorruptedError /
 *            P5RunStateNotFoundError / P5RunStateAlreadyExistsError /
 *            P5RunStateVerifyFailedError
 *    - 类型：P5RunState / P5LoopType / P5RunStateStatus /
 *            P5RunStateStoreErrorKind / P5LogCallback
 *    - 常量：P5_STAGE_ORDER / P5_RUN_STATE_STATUSES / P5_DEFAULT_RUN_STATE_DIR 等
 *
 * 5. NotesMemory 跨轮记忆（Phase 5.2 TASK-P5-1.2-002）：
 *    - 类：P5NotesMemory
 *    - 工厂：createDefaultP5NotesMemory
 *    - 错误：P5NotesMemoryError
 *    - 类型：P5NotesSection / P5DecisionRecord / P5NotesMemoryErrorKind / P5NotesLogCallback
 *    - 常量：P5_DEFAULT_NOTES_DIR / P5_NOTES_EXTENSION / P5_DECISION_TAG 等
 *
 * 6. SmartConfirmation 三态确认（Phase 5.2 TASK-P5-1.2-003）：
 *    - 类：P5SmartConfirmation
 *    - 工厂：createDefaultP5SmartConfirmation
 *    - 工具：p5ScoreToLevel
 *    - 类型：P5RiskLevel / P5ConfirmationDecision / P5ConfirmationResult /
 *            P5SmartConfirmationOptions
 *    - 常量：P5_CONFIRMATION_DECISIONS
 *
 * 7. StageHandler 共享类型与 4 个实现（Phase 5.2 TASK-P5-1.2-004~007）：
 *    - 类型：P5StageKind / P5StageResultKind / P5StageContext / P5StageResult / P5StageHandler
 *    - 工厂：createSuccessStageResult / createFailedStageResult / buildGuardContext / toGuardRecords
 *    - 常量：P5_STAGE_KINDS / P5_STAGE_RESULT_KINDS
 *    - PlanStageHandler：P5PlanStageHandler / createPlanStageHandler / parseTaskCards / pickNextPendingTask
 *    - DevStageHandler：P5DevStageHandler / createDevStageHandler / isWithinPath
 *    - VerifyStageHandler：P5VerifyStageHandler / parseTestOutput / TestResultStats
 *    - FixStageHandler：P5FixStageHandler / createFixStageHandler /
 *                      analyzeFailureCategory / detectCleanupIntent /
 *                      FixFailureCategory / FixSuggestion
 *
 * 8. LoopExecutor 分流器（Phase 5.2 TASK-P5-1.2-008）：
 *    - 类：P5LoopExecutor
 *    - 工厂：createP5LoopExecutor / createP5LoopExecutorFromHandlers
 *    - 类型：P5LoopExecutorOptions / P5LoopExecutorLogCallback / P5LoopExecutorStats
 *    - 常量：P5_LOOP_EXECUTOR_TIMEOUT_MS
 *
 * 9. AutonomousOrchestrator 主控制器（Phase 5.2 TASK-P5-1.2-009）：
 *    - 类：AutonomousOrchestrator
 *    - 工厂：createAutonomousOrchestrator
 *    - 类型：AutonomousRunRequest / AutonomousRunResult / P5MilestoneRecord /
 *            P5BlockageReport / AutonomousOrchestratorOptions /
 *            AutonomousOrchestratorLogCallback
 *    - 常量：AUTONOMOUS_DEFAULT_MAX_ITERATIONS（10）/ AUTONOMOUS_DEFAULT_MAX_TOKENS（200000）/
 *            AUTONOMOUS_DEFAULT_CONSECUTIVE_FAILURE_ABORT（3）/
 *            AUTONOMOUS_DEFAULT_TEST_COMMAND（"npm test"）/
 *            AUTONOMOUS_DEFAULT_TEST_TIMEOUT_SEC（600）等
 *
 * 使用方式：
 * ```typescript
 * import {
 *   SymbolGraphStore, EdgeResolver, ImpactBFS,
 *   EnvBoundaryGuard, DangerousCommandGuard, ScopeLockGuard,
 *   FakeCompletionGuard, CredentialMisuseGuard, RuntimeConstraintGuard,
 *   BlockerGuardChain, createDefaultBlockerGuardChain,
 *   P5RunStateStore, P5NotesMemory, P5SmartConfirmation,
 *   P5LoopExecutor, createP5LoopExecutorFromHandlers,
 *   AutonomousOrchestrator, createAutonomousOrchestrator,
 *   P5PlanStageHandler, P5DevStageHandler, P5VerifyStageHandler, P5FixStageHandler,
 *   GuardViolationError,
 *   type GuardContext, type GuardVerdict,
 *   type P5StageContext, type P5StageResult,
 *   type AutonomousRunRequest, type AutonomousRunResult,
 * } from "./eag/p5";
 * ```
 *
 * @module eag/p5
 */

// ============================================================================
// 1. 符号图谱存储导出（Phase 5.1 TASK-P5-1.1-003~005）
// ============================================================================

export {
  SymbolGraphStore,
  isGraphStoreAvailable,
  CONFIDENCE_VALUE_MAP,
  CONFIDENCE_EXTRACTED,
  CONFIDENCE_AMBIGUOUS,
  CONFIDENCE_UNRESOLVED,
} from "./symbol-graph-store";

export type {
  SymbolKind,
  EdgeKind,
  EdgeConfidence,
  SymbolRecord,
  EdgeRecord,
  ImpactResult,
  ImpactPath,
  GraphStats,
} from "./symbol-graph-store";

export { EdgeResolver } from "./edge-resolver";
export type { ResolvedEdge } from "./edge-resolver";

export { ImpactBFS, computeDepthDecayedWeight, computeEdgeWeight } from "./impact-bfs";

export type { ImpactBFSOptions } from "./impact-bfs";

// ============================================================================
// 2. 6 层 15 条 BLOCKER 守护链类型导出（Phase 5.2 TASK-P5-5.2-001）
// ============================================================================

export type {
  GuardLayer,
  GuardRuleId,
  GuardSeverity,
  GuardDecision,
  GuardContext,
  GuardVerdict,
  GuardRule,
  GuardChainResult,
  GuardRecord,
  TaskCard,
  ChangeDiff,
  ChangedFile,
  CompletionEvidence,
} from "./guards/types";

export {
  GuardViolationError,
  createPassVerdict,
  createDenyVerdict,
  createAskVerdict,
  GUARD_LAYER_ORDER,
  ALL_GUARD_RULE_IDS,
  RULE_TO_LAYER,
  RULE_TO_SEVERITY,
} from "./guards/types";

// ============================================================================
// 3. 6 个 Guard 类导出（Phase 5.2 TASK-P5-5.2-002~006）
// ============================================================================

export { EnvBoundaryGuard } from "./guards/env-boundary-guard";
export {
  ENV_BOUNDARY_PROTECTED_ENV_VARS,
  ENV_BOUNDARY_SYSTEM_SENSITIVE_PREFIXES,
  ENV_BOUNDARY_PROD_CREDENTIAL_PATTERNS,
} from "./guards/env-boundary-guard";

export { DangerousCommandGuard } from "./guards/dangerous-command-guard";
export {
  DANGEROUS_COMMAND_GUARD_PATTERNS,
  DANGEROUS_COMMAND_DELETE_PATTERNS,
  DANGEROUS_COMMAND_AUTO_ALLOWLIST,
  DANGEROUS_COMMAND_MAX_BATCH_DELETE_THRESHOLD,
} from "./guards/dangerous-command-guard";

export {
  ScopeLockGuard,
  FakeCompletionGuard,
  CredentialMisuseGuard,
  RuntimeConstraintGuard,
  SCOPE_LOCK_CLEANUP_KEYWORDS,
  CREDENTIAL_MISUSE_FILE_PATTERNS,
  CREDENTIAL_MISUSE_GITLEAKS_PATTERNS,
  FAKE_COMPLETION_STOP_WHEN_ALLOWLIST,
  FAKE_COMPLETION_STOP_WHEN_BLACKLIST,
  RUNTIME_CONSTRAINT_IMMUTABLE_FIELDS,
} from "./guards/scope-fake-cred-runtime-guards";

// ============================================================================
// 4. BlockerGuardChain 守护链调度器导出（Phase 5.2 TASK-P5-5.2-007）
// ============================================================================

export {
  BlockerGuardChain,
  createDefaultBlockerGuardChain,
  BLOCKER_GUARD_CHAIN_TIMEOUT_MS,
} from "./guards/blocker-guard-chain";

export type { BlockerGuardChainOptions } from "./guards/blocker-guard-chain";

// ============================================================================
// 5. RunState 持久化存储导出（Phase 5.2 TASK-P5-1.2-001）
// ============================================================================

export {
  P5RunStateStore,
  createDefaultP5RunStateStore,
  P5RunStateStoreError,
  P5RunStateCorruptedError,
  P5RunStateNotFoundError,
  P5RunStateAlreadyExistsError,
  P5RunStateVerifyFailedError,
  P5_STAGE_ORDER,
  P5_RUN_STATE_STATUSES,
  P5_RUN_STATE_LOCK_TIMEOUT_MS,
  P5_RUN_STATE_LOCK_RETRY_INTERVAL_MS,
  P5_DEFAULT_RUN_STATE_DIR,
  P5_JSONL_EXTENSION,
  P5_LOCK_FILE_SUFFIX,
  P5_CHECKSUM_PREFIX,
} from "./run-state-store";

export type {
  P5RunState,
  P5LoopType,
  P5RunStateStatus,
  P5RunStateStoreErrorKind,
  P5LogCallback,
} from "./run-state-store";

// ============================================================================
// 6. NotesMemory 跨轮记忆导出（Phase 5.2 TASK-P5-1.2-002）
// ============================================================================

export {
  P5NotesMemory,
  createDefaultP5NotesMemory,
  P5NotesMemoryError,
  P5_DEFAULT_NOTES_DIR,
  P5_NOTES_EXTENSION,
  P5_DEFAULT_MAX_SIZE_KB,
  P5_DEFAULT_TRIM_KEEP_LAST_N,
  P5_DECISION_TAG,
} from "./notes-memory";

export type { P5NotesSection, P5DecisionRecord, P5NotesMemoryErrorKind, P5NotesLogCallback } from "./notes-memory";

// ============================================================================
// 7. SmartConfirmation 三态确认导出（Phase 5.2 TASK-P5-1.2-003 + Phase 5.3 TASK-P5-5.3-001 扩展）
// ============================================================================

export {
  P5SmartConfirmation,
  createDefaultP5SmartConfirmation,
  p5ScoreToLevel,
  P5_CONFIRMATION_DECISIONS,
} from "./smart-confirmation";

export type {
  P5RiskLevel,
  P5ConfirmationDecision,
  P5ConfirmationResult,
  P5SmartConfirmationOptions,
  // Phase 5.3 TASK-P5-5.3-001 扩展数据源类型
  P5SmartConfirmationContext,
  P5DataSourceContribution,
  P5ExtendedConfirmationResult,
} from "./smart-confirmation";

// ============================================================================
// 7.1 ConfirmationHistoryStore 历史决策存储导出（Phase 5.3 TASK-P5-5.3-002）
// ============================================================================

export {
  P5ConfirmationHistoryStore,
  createDefaultP5ConfirmationHistoryStore,
  P5ConfirmationHistoryStoreError,
  P5_HISTORY_DECISIONS,
  P5_HISTORY_STAGES,
  P5_DEFAULT_HISTORY_DIR,
  P5_HISTORY_EXTENSION,
  P5_DEFAULT_HISTORY_MAX_SIZE_KB,
  P5_DEFAULT_HISTORY_TRIM_KEEP_LAST_N,
} from "./confirmation-history-store";

export type {
  P5ConfirmationHistoryEntry,
  P5ConfirmationQueryPattern,
  P5ConfirmationHistoryStats,
  P5HistoryStoreErrorKind,
  P5HistoryLogCallback,
} from "./confirmation-history-store";

// ============================================================================
// 8. StageHandler 共享类型导出（Phase 5.2 TASK-P5-1.2-004~007）
// ============================================================================

export {
  P5_STAGE_KINDS,
  P5_STAGE_RESULT_KINDS,
  createSuccessStageResult,
  createFailedStageResult,
  buildGuardContext,
  toGuardRecords,
} from "./handlers/types";

export type { P5StageKind, P5StageResultKind, P5StageContext, P5StageResult, P5StageHandler } from "./handlers/types";

// ============================================================================
// 9. 4 个 StageHandler 导出（Phase 5.2 TASK-P5-1.2-004~007）
// ============================================================================

export {
  P5PlanStageHandler,
  createPlanStageHandler,
  parseTaskCards,
  pickNextPendingTask,
} from "./handlers/plan-stage-handler";

export {
  P5DevStageHandler,
  createDevStageHandler,
  isWithinPath,
  extractTaskCardFromPrevResults as extractTaskCardFromDevPrevResults,
} from "./handlers/dev-stage-handler";

export { P5VerifyStageHandler, parseTestOutput } from "./handlers/verify-stage-handler";

export type { TestResultStats } from "./handlers/verify-stage-handler";

export {
  P5FixStageHandler,
  createFixStageHandler,
  analyzeFailureCategory,
  detectCleanupIntent,
} from "./handlers/fix-stage-handler";

export type { FixFailureCategory, FixSuggestion } from "./handlers/fix-stage-handler";

// ============================================================================
// 10. LoopExecutor 分流器导出（Phase 5.2 TASK-P5-1.2-008）
// ============================================================================

export {
  P5LoopExecutor,
  createP5LoopExecutor,
  createP5LoopExecutorFromHandlers,
  P5_LOOP_EXECUTOR_TIMEOUT_MS,
} from "./loop-executor";

export type { P5LoopExecutorOptions, P5LoopExecutorLogCallback, P5LoopExecutorStats } from "./loop-executor";

// ============================================================================
// 11. AutonomousOrchestrator 主控制器导出（Phase 5.2 TASK-P5-1.2-009）
// ============================================================================

export {
  AutonomousOrchestrator,
  createAutonomousOrchestrator,
  AUTONOMOUS_DEFAULT_MAX_ITERATIONS,
  AUTONOMOUS_DEFAULT_MAX_TOKENS,
  AUTONOMOUS_DEFAULT_CONSECUTIVE_FAILURE_ABORT,
  AUTONOMOUS_DEFAULT_TEST_COMMAND,
  AUTONOMOUS_DEFAULT_TEST_TIMEOUT_SEC,
  AUTONOMOUS_DEFAULT_STOP_WHEN,
  AUTONOMOUS_DEFAULT_INITIAL_LOOP,
  AUTONOMOUS_DEFAULT_TASKS_FILENAME,
  AUTONOMOUS_DEFAULT_TASKS_DIR,
} from "./autonomous-orchestrator";

export type {
  AutonomousRunRequest,
  AutonomousRunResult,
  P5MilestoneRecord,
  P5BlockageReport,
  AutonomousOrchestratorOptions,
  AutonomousOrchestratorLogCallback,
} from "./autonomous-orchestrator";
