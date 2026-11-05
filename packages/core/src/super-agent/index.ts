/**
 * Super Agent 公共出口
 *
 * ## 稳定性分级
 *
 * `@experimental` —— 首期骨架，接口可能随真实接入调整。
 * 与 `packages/core/src/index.ts` 的挂载保持一致：导出时统一带
 * `@experimental` 注释（见 core index 的挂载段）。
 *
 * ## 使用方式
 *
 * ```ts
 * import { SuperAgentRuntime } from "@vegamo/deepcode-core";
 *
 * const runtime = await SuperAgentRuntime.create({
 *   databasePath: "/abs/path/super-agent.db",
 *   projectRoot: process.cwd(),
 * });
 * await runtime.start();
 * ```
 *
 * @module super-agent/index
 */

// --- 身份（常驻主理智能体「司南」） ---
export { SUPER_AGENT_IDENTITY, buildIdentityPreamble, superAgentName, superAgentSignature } from "./identity.js";

// --- Soul（四层人格 + 分类记忆） ---
export {
  DEFAULT_USER_PROFILE,
  MEMORY_CATEGORIES,
  SINAN_EMOTION,
  SINAN_ESSENCE,
  SINAN_EXPRESSION,
  SINAN_PERSONALITY,
  SINAN_PRESET_NAME,
  SoulEngine,
  TONE_DIRECTIVES,
  TONE_LABELS,
  allCategories,
  buildMemory,
  buildSoulSnapshot,
  categoryDefinition,
  categoryHints,
  categoryLabel,
  classifyMemoryText,
  countByCategory,
  createSinanSoul,
  defaultTitle,
  describeOcean,
  detectTone,
  emptyCategoryCount,
  emptyMemoryFile,
  groupByCategory,
  isSecretCategory,
  memoryFreshness,
  memoryImportance,
  memoryLabel,
  missingCategories,
  normalizeMemoryFile,
  organizeMemories,
  recallMemories,
  redactSecret,
  renderSoulPrompt,
  scoreMemory,
  suggestMemoryKey,
  toneLabel,
  upsertMemory,
  withMemories,
  AVATAR_DATA_URL_MAX,
  DEFAULT_SOUL_CONFIG,
  DEFAULT_VOICE_DESCRIPTION,
  DEFAULT_VOICE_ENDPOINT,
  DEFAULT_WAKE_WORD,
  VOICE_ENGINES,
  VOICE_PRESETS,
  VOICE_SPEED_MAX,
  VOICE_SPEED_MIN,
  WAKE_WORD_MAX_LENGTH,
  defaultVoiceConfig,
  findVoicePreset,
  normalizeAvatarConfig,
  normalizeSoulConfig,
  normalizeVoiceConfig,
  // 语音默认值的平台差异（本机有 MLX 语音模型才默认开）
  defaultSpeakReplies,
  defaultVoiceEnabled,
  isVoiceCapablePlatform,
  // 对话模式（工作 / 陪伴）
  COMPANION_PRESETS,
  DEFAULT_COMPANION_CONFIG,
  SOUL_MODES,
  applySoulMode,
  findCompanionPreset,
  normalizeCompanionConfig,
  parseSoulMode,
  renderModeSection,
  soulModeLabel,
  soulModeOptions,
  // 记忆统一存储（Soul ↔ V2）：纯映射在 soul/ 内核，读写适配在 soul-memory-store.ts
  isSoulEntry,
  memoryEntryToSoul,
  soulEntryToMemoryEntry,
} from "./soul/index.js";
export type {
  CategoryDefinition,
  ClassificationResult,
  CommunicationStyle,
  CoreEssence,
  DecisionStyle,
  EmotionalState,
  EmotionalTone,
  ExpressionStyle,
  MemoryCategory,
  MemoryGroup,
  MemoryItemView,
  MemorySensitivity,
  MoralPrinciple,
  NameIdentity,
  OceanTraits,
  OrganizeReport,
  OriginStory,
  PersonalityMatrix,
  RecallOptions,
  RecalledMemory,
  RememberResult,
  RenderOptions,
  ScopedSoulStore,
  Soul,
  SoulAvatarConfig,
  SoulCompanionConfig,
  SoulConfig,
  SoulEngineOptions,
  SoulMemory,
  SoulMemoryFile,
  SoulMemoryStore,
  SoulMode,
  SoulSnapshot,
  SoulVoiceConfig,
  UserProfile,
  VoiceEngine,
} from "./soul/index.js";
export {
  FileSoulStore,
  createSoulEngine,
  defaultSoulStores,
  legacySoulMemoryPath,
  loadSoulConfig,
  migrateSoulMemory,
  readSoulMode,
  saveSoulConfig,
  soulConfigPath,
  soulMemoryLocations,
  soulMemoryPath,
  soulRevealSecretsFromEnv,
} from "./soul-io.js";
// Soul 记忆的统一存储适配层：需要 node:fs 与 v2/MemoryStore，故不在 soul/ 内核下
export { UnifiedSoulStore, migrateLegacySoulMemory } from "./soul-memory-store.js";
export type { SoulMigrationReport } from "./soul-memory-store.js";

// --- 计划层（动态分解 / 工作流 / 组队） ---
export {
  LlmWorkflowPlanner,
  NullPlanner,
  StaticPlanner,
  DEFAULT_PLANNER_TIMEOUT_MS,
  PLANNER_SYSTEM_PROMPT,
  defaultRoleNames,
  renderPlannerRequest,
  renderPlannerSystemPrompt,
  type LlmWorkflowPlannerOptions,
  type WorkflowPlanner,
} from "./planner/planner.js";
export {
  buildFallbackPlan,
  extractPlanJsonObject,
  parsePlan,
  renderPlan,
  FALLBACK_ROLE,
  MAX_PLAN_STEPS,
  type ParsePlanOptions,
} from "./planner/parse.js";
export { findBlockedSteps, findRunnableSteps, isPlanComplete, planWaves, waveIndexOf } from "./planner/waves.js";
export type {
  BlockedStep,
  PlanParseResult,
  PlanRequest,
  PlanSource,
  PlanStep,
  PlanStepState,
  PlanStepStateRecord,
  PlanWave,
  TeamMember,
  WorkPlan,
} from "./planner/types.js";

// --- 运行时（组合根） ---
export {
  SuperAgentRuntime,
  type SuperAgentRuntimeOptions,
  type SuperAgentSourceSpec,
  type SuperAgentStatus,
  type WriteSide,
} from "./runtime.js";

// --- 领域类型 ---
export {
  isAssignmentEnded,
  isExplicitStrength,
  isTicketActive,
  isTicketOpen,
  waitsForPerson,
  type AcceptMode,
  type AdmissionCell,
  type Assignment,
  type AssignmentState,
  type Attention,
  type AttentionDraft,
  type Decision,
  type DecisionKind,
  type Disposition,
  type DispositionKind,
  type EvalCandidate,
  type EvalState,
  type HistoricalDecision,
  type IntakeResult,
  type Mandate,
  type NewTrigger,
  type Policy,
  type PolicyRule,
  type SourceDescriptor,
  type SourcePolicyPart,
  type Strength,
  type Subscription,
  type Thread,
  type Ticket,
  type TicketExecution,
  type TicketInput,
  type TicketInputKind,
  type TicketMessage,
  type TicketMessageDirection,
  type TicketMessageState,
  type TicketState,
  type TicketSummary,
  type Trigger,
  type TriggerActorKind,
  type WorkerReport,
  type WorkerReportKind,
} from "./domain/types.js";

// --- 错误 ---
export {
  isUserError,
  USER_ERROR_CODES,
  UserError,
  authorizationRevoked,
  budgetExceeded,
  invalidRequest,
  notFound,
  stateConflict,
  storeUnavailable,
} from "./domain/errors.js";
export type { UserErrorCode } from "./domain/errors.js";

// --- ID ---
export { fingerprint, makeId, makeIdempotencyKey, makeThreadId } from "./domain/ids.js";

// --- 持久层 ---
export { openStore, isSqliteAvailable, Store, toSqliteInt, fromSqliteInt } from "./store/store.js";
export type { StoreOptions, StoreTx } from "./store/store.js";
export { SuperAgentRepositories } from "./store/repositories.js";
export { runMigrations, SCHEMA_VERSION } from "./store/schema.js";

// --- 策略 ---
export {
  createDefaultPolicy,
  DEFAULT_ACCEPT_MODE,
  DEFAULT_POLICY_RULES,
  evaluateGate,
  findSourcePart,
  loadPolicy,
  POLICY_KV_KEY,
  revalidateMandate,
  validatePolicy,
  withAcceptMode,
  type GateInput,
  type GateOutcome,
} from "./policy/policy.js";

// --- 引擎 ---
export {
  SuperAgentEngine,
  type Assessor,
  type DecisionInput,
  type DecisionResult,
  type EffectKind,
  type EngineContext,
  type EngineForExecutor,
  type EngineForPeople,
  type EngineForRouter,
  type EngineForSettings,
  type EngineForSources,
  type TicketDetail,
  type WorkerExecutor,
} from "./engine/engine.js";

// --- 上下文层（双层投影：任务层 + 历史经验） ---
export {
  buildContext,
  renderHistoryContext,
  renderTaskContext,
  DEFAULT_CONTEXT_BUDGET,
  DEFAULT_REPORT_HISTORY_LIMIT,
  type BuildContextInput,
  type ContextBundle,
  type ContextDeps,
  type ContextSnippet,
  type ContextSnippetKind,
} from "./engine/context.js";
export {
  recallHistoricalDecisions,
  DEFAULT_CANDIDATE_LIMIT,
  DEFAULT_RECALL_LIMIT,
  type HistoricalRecall,
  type RecallDeps,
  type RecallHistoricalInput,
} from "./engine/history.js";
export {
  estimateTokens,
  jaccard,
  kindWeight,
  recencyScore,
  recallHistorical,
  KEYWORD_WEIGHT,
  KIND_WEIGHT,
  KIND_WEIGHTS,
  MIN_JACCARD,
  RECENCY_HALF_LIFE_MS,
  RECENCY_WEIGHT,
  type RecallCandidate,
  type RecallHit,
} from "./domain/recall.js";

// --- 副作用与调度 ---
export { Effects, type EffectHandler, type EffectHealth, type EffectOutcome } from "./effects/effects.js";
export { Passes, type PassesOptions } from "./passes/passes.js";

// --- Router ---
export { SuperAgentRouter, type SuperAgentRouterOptions } from "./router/router.js";
export {
  ASSESSMENT_SYSTEM_PROMPT,
  DEFAULT_ASSESSMENT_TIMEOUT_MS,
  LlmAssessor,
  NullAssessor,
  parseAssessment,
  type HistoricalRecallPort,
  type LlmAssessorOptions,
} from "./router/assessment.js";

// --- Worker ---
export {
  BackgroundRunnerLauncher,
  SuperAgentWorkerExecutor,
  type InjectOutcome,
  type WorkerInjector,
  type WorkerLauncher,
  type SuperAgentWorkerExecutorOptions,
} from "./worker/executor.js";
export { WorkerInstructionChannel, WorkerInstructionRegistry, type WorkerInstruction } from "./worker/channel.js";
export {
  buildAttentionReport,
  buildFailedReport,
  buildProgressReport,
  buildReadyReport,
  parseWorkerReport,
  WORKER_OUTPUT_CONTRACT,
} from "./worker/report.js";

// --- Source ---
export {
  SourceRegistry,
  type SourceConfig,
  type SourceField,
  type SourceInstance,
  type SourceKind,
  type TriggerSink,
} from "./source/kind.js";
export { LocalWatcherSource, localWatcherKind, type LocalWatcherConfig } from "./source/local-watcher.js";
