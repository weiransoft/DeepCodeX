/**
 * V2 上下文记忆体系 - 公共 API 聚合层
 *
 * 设计依据：
 * - V2_CONTEXT_MEMORY_TECH_DESIGN.md §14.5（V2 路线完成状态）
 * - 架构师审查报告（2026-07-21）：建议先建 v2/index.ts 中间聚合层，
 *   再由 packages/core/src/index.ts re-export，与 team/index.ts 风格一致
 *
 * 聚合范围（8 个子模块）：
 *   1. context     - 全局上下文 / 双层管理器 / 滑动窗口 / 渐进加载 / 相关性评分 / 同步器
 *   2. memory      - 记忆存储 / 项目记忆 / 隐私管理 / 摘要器 / 经验推荐 / 用户全局记忆
 *   3. codemap     - 代码地图生成器 / 文件监视器 / 正则分析器
 *   4. understanding - 项目理解 / 业务领域建模
 *   5. diff        - Myers diff / 补丁应用 / 补丁摘要 / Diff 预览增强
 *   6. approval    - 审批门 / 命令安全 / Side Git / 工具路由 / 恢复
 *   7. integration - 会话 Hook / 审批 Hook / 编辑 Hook / 设置桥接
 *   8. observability - V2 事件日志
 *
 * 导出原则（白名单导出）：
 *   - 仅导出 public API（类、接口、常量、类型），不导出内部辅助函数
 *   - 区分 `export`（值）与 `export type`（类型），与 core/index.ts 风格一致
 *   - 使用 .js 扩展名（项目 ESM 约定）
 *   - 不再 re-export integration/v1-adapters.ts（避免与 core/index.ts 主导出重复）
 *
 * V2 路线完成状态：
 *   - V2-P0a/P0b/P1/P2/P3 五个阶段全部完成（524/524 测试全绿）
 *   - 详见 V2_CONTEXT_MEMORY_TECH_DESIGN.md §14.5
 *
 * @module v2/index
 */

// ============================================================================
// 1. context 子模块 - 上下文记忆核心
// ============================================================================

// 全局上下文（GlobalContext + GlobalContextManager）
export type {
  GlobalContext,
  UserProfile,
  DomainKnowledge,
  SimpleKnowledgeGraph,
  GraphNode,
  GraphEdge,
  ConceptEntry,
  RuleEntry,
  CaseEntry,
  BestPracticeEntry,
  HistoricalExperience,
  SuccessExperience,
  FailureExperience,
  ExperiencePattern,
  CollaborationNetwork,
  CollaborationIntegration,
  CollaborationPreference,
  CapabilityModel,
  CapabilityAssessment,
} from "./context/global-context.js";
export {
  createDefaultGlobalContext,
  GlobalContextManager,
  SCHEMA_VERSION as GLOBAL_CONTEXT_SCHEMA_VERSION,
  MAX_SUCCESS_EXPERIENCES,
  MAX_FAILURE_EXPERIENCES,
  MAX_EXPERIENCE_PATTERNS,
} from "./context/global-context.js";

// 任务上下文类型定义
export type {
  TaskStatus,
  TaskDefinition,
  TaskState,
  WorkingMemory,
  FocusPoint,
  ThoughtEntry,
  IntermediateResult,
  PendingItem,
  SkillContext,
  SkillLoadRecord,
  TaskContext,
  TaskArchiveSummary,
  ArchiveCallback,
} from "./context/types.js";

// 双层上下文管理器（DualLayerContextManager）
export type { DualLayerContextConfig, CodeMapProvider } from "./context/dual-layer-manager.js";
export { DualLayerContextManager } from "./context/dual-layer-manager.js";

// 滑动窗口（SlidingWindowManager）
export type { SlidingWindowConfig, SlidingWindowResult } from "./context/sliding-window.js";
export { SlidingWindowManager } from "./context/sliding-window.js";

// 渐进式上下文加载器（ProgressiveContextLoader）
export type { ProgressiveLoaderConfig, ProgressiveLoadResult } from "./context/progressive-loader.js";
export { ProgressiveContextLoader } from "./context/progressive-loader.js";

// 相关性评分器（RelevanceScorer）
export type { RelevanceScoringConfig, RelevanceScoreInput, RelevanceScore } from "./context/relevance-scorer.js";
export { RelevanceScorer } from "./context/relevance-scorer.js";

// 上下文同步器（ContextSynchronizer）
export type { ContextConflict, SyncResult } from "./context/synchronizer.js";
export { ContextSynchronizer } from "./context/synchronizer.js";

// 任务上下文管理器（TaskContextManager）
export { TaskContextManager } from "./context/task-context-manager.js";

// ============================================================================
// 2. memory 子模块 - 记忆持久化与隐私管理
// ============================================================================

// 记忆类型与基础接口
export type {
  MemoryType,
  MemorySource,
  MemoryEntry,
  MemoryStoreData,
  MemoryListResult,
  MemoryDeleteResult,
} from "./memory/types.js";

// 记忆存储（MemoryStore）
export { MemoryStore } from "./memory/memory-store.js";

// 项目记忆（ProjectMemoryManager）
export type {
  ProjectMemory,
  ProjectConfig,
  ProjectDomainKnowledge,
  ProjectHistoryEntry,
  KnownIssue,
  ProjectUnderstandingInput,
} from "./memory/project-memory.js";
export {
  ProjectMemoryManager,
  createDefaultProjectMemory,
  generateProjectId,
  generateIssueFingerprint,
  SCHEMA_VERSION as PROJECT_MEMORY_SCHEMA_VERSION,
  MAX_PROJECT_HISTORY,
  MAX_KNOWN_ISSUES,
} from "./memory/project-memory.js";

// 隐私管理（MemoryPrivacyManager + InvalidConfirmTokenError）
export type { ExportResult, DeleteReport, MemoryExport } from "./memory/privacy-manager.js";
export { MemoryPrivacyManager, InvalidConfirmTokenError, MemoryExportSchema } from "./memory/privacy-manager.js";

// 内容摘要器（ContentSummarizer 接口 + DeepSeek / RuleBased 实现 + Factory）
export type { KeyInfo, ContentSummarizer, SummarizerConfig } from "./memory/content-summarizer.js";
export { DeepSeekSummarizer } from "./memory/deepseek-summarizer.js";
export { RuleBasedSummarizer } from "./memory/rule-based-summarizer.js";
export { createSummarizer } from "./memory/summarizer-factory.js";

// 经验推荐器（ExperienceRecommender）
export type { ExperienceRecommendation, TaskFeatures, RecommendOptions } from "./memory/experience-recommender.js";
export {
  ExperienceRecommender,
  CONTEXT_SNIPPET_TYPE as EXPERIENCE_CONTEXT_SNIPPET_TYPE,
} from "./memory/experience-recommender.js";

// 用户全局记忆（UserGlobalMemoryManager）
export type { UserGlobalMemory, Fact } from "./memory/user-global-memory.js";
export {
  UserGlobalMemoryManager,
  CONTEXT_SNIPPET_TYPE as USER_GLOBAL_CONTEXT_SNIPPET_TYPE,
} from "./memory/user-global-memory.js";

// .gitignore 过滤器（GitignoreFilter）
export type { GitignoreRule } from "./memory/gitignore-filter.js";
export { GitignoreFilter, parseGitignoreLine, matchesGitignore } from "./memory/gitignore-filter.js";

// 敏感信息脱敏（SensitiveInfoRedactor）
export type { RedactionRule, RedactionHit, RedactionResult, RedactionLogEntry } from "./memory/redaction.js";
export { SensitiveInfoRedactor, DEFAULT_REDACTION_RULES } from "./memory/redaction.js";

// /memory 命令处理器（handleMemoryCommand + MemoryCommandResult）
export type { MemoryCommandResult } from "./memory/memory-commands.js";
export { handleMemoryCommand } from "./memory/memory-commands.js";

// ============================================================================
// 3. codemap 子模块 - 代码地图生成与监视
// ============================================================================

// 代码地图生成器（CodeMapGenerator + 全部类型）
export type {
  CodeMapConfig,
  CallEdge,
  DependencyEdge,
  TechStackInfo,
  ArchitectureType,
  ProjectInfo,
  ModuleInfo,
  CodeMapStats,
  CodeMap,
  FileInfo,
  FunctionInfo,
  SupportedLanguage,
} from "./codemap/generator.js";
export { CodeMapGenerator } from "./codemap/generator.js";

// 代码地图 Markdown 渲染器（renderCodeMapAsMarkdown，CM-13）
// 纯函数：CodeMap → Markdown 字符串，无副作用
export { renderCodeMapAsMarkdown } from "./codemap/markdown-renderer.js";

// /codemap 命令处理器（handleCodemapCommand + CodemapCommandResult，CMD-01/CMD-02）
export type { CodemapCommandResult } from "./codemap/codemap-commands.js";
export { handleCodemapCommand } from "./codemap/codemap-commands.js";

// 正则 AST 分析器（RegexASTAnalyzer）
export type { ClassInfo } from "./codemap/regex-analyzer.js";
export { RegexASTAnalyzer, detectLanguage } from "./codemap/regex-analyzer.js";

// 代码地图文件监视器（CodeMapFileWatcher）
export type { FileWatchEvent, FileWatcherConfig } from "./codemap/file-watcher.js";
export { CodeMapFileWatcher, attachFileWatcher } from "./codemap/file-watcher.js";

// ============================================================================
// 4. understanding 子模块 - 项目理解与业务领域建模
// ============================================================================

// 项目理解服务（ProjectUnderstandingService）
export type { ProjectUnderstanding } from "./understanding/project-understanding.js";
export { ProjectUnderstandingService } from "./understanding/project-understanding.js";

// 业务领域建模器（DomainModeler）
export type { DomainModel, DomainConcept, DomainRelation, DomainRule } from "./understanding/domain-modeler.js";
export {
  DomainModeler,
  CONTEXT_SNIPPET_TYPE as DOMAIN_MODELER_CONTEXT_SNIPPET_TYPE,
} from "./understanding/domain-modeler.js";

// ============================================================================
// 5. diff 子模块 - Myers diff 与补丁应用
// ============================================================================

// Myers diff 算法
export type { DiffOpType, DiffOp, DiffHunk, DiffStats } from "./diff/myers-diff.js";
export { computeMyersDiff, groupIntoHunks, computeStats } from "./diff/myers-diff.js";

// 补丁应用（ApplyPatch）
export type {
  ApplyPatchOptions,
  PatchLineType,
  PatchLine,
  PatchHunk,
  PatchFile,
  ApplyResult,
  ApplyFailure,
  PatchCandidate,
  SingleHunkResult,
} from "./diff/apply-patch.js";
export { ApplyPatch } from "./diff/apply-patch.js";

// 补丁摘要生成器（PatchSummaryGenerator）
export type { DiffResult, FileChangeSummary, PatchSummary } from "./diff/patch-summary.js";
export { PatchSummaryGenerator } from "./diff/patch-summary.js";

// Diff 预览增强（enhanceDiffPreview）
export type { DiffPreviewOptions, DiffPreviewResult } from "./diff/enhance-diff-preview.js";
export { enhanceDiffPreview } from "./diff/enhance-diff-preview.js";

// ============================================================================
// 6. approval 子模块 - 审批门 / 命令安全 / Side Git / 工具路由
// ============================================================================

// 审批类型定义
export type {
  ApprovalMode,
  AppMode,
  ApprovalDecision,
  RiskLevel,
  ToolCategory,
  RiskAssessment,
  ApprovalContext,
  ApprovalResult,
  ApprovalConfig,
} from "./approval/types.js";

// 审批门（ApprovalGate）
export { ApprovalGate } from "./approval/approval-gate.js";

// 审批拒绝错误（ApprovalDeniedError）
export { ApprovalDeniedError } from "./approval/approval-denied-error.js";

// 命令安全（CommandSafety + 黑白名单常量）
export {
  CommandSafety,
  BUILTIN_BLACKLIST,
  BUILTIN_WHITELIST,
  BUILTIN_BLACKLIST_REGEX,
  BUILTIN_WHITELIST_REGEX,
} from "./approval/command-safety.js";

// 命令安全分类器（CommandSafetyClassifier）
export type { ArityEntry, CommandClassification } from "./approval/arity-classifier.js";
export { CommandSafetyClassifier, DEFAULT_ARITY_DICTIONARY } from "./approval/arity-classifier.js";

// Side Git 管理器（SideGitManager）
export type {
  SideGitConfig,
  TurnSnapshot,
  RevertPreview,
  ListSnapshotsOptions,
  SideGitStats,
} from "./approval/side-git.js";
export { SideGitManager, generateTurnId, projectHash } from "./approval/side-git.js";

// Side Git 命令注册（registerSideGitCommands）
export type { CommandRegistry, CommandResult } from "./approval/side-git-commands.js";
export { registerSideGitCommands } from "./approval/side-git-commands.js";

// Side Git 恢复（SideGitRecovery）
export type { IntegrityFailure, IntegrityReport } from "./approval/side-git-recovery.js";
export { SideGitRecovery } from "./approval/side-git-recovery.js";

// 工具路由（ToolRouter）
export type { AskUserCallback } from "./approval/tool-router.js";
export { ToolRouter } from "./approval/tool-router.js";

// ============================================================================
// 7. integration 子模块 - V1/V2 集成 Hook
// ============================================================================

// 会话上下文 Hook（DefaultSessionContextHook）
export type { ContextSnippet, SessionContextHook } from "./integration/session-hook.js";
export { DefaultSessionContextHook } from "./integration/session-hook.js";

// 审批 Hook 工厂函数
export { createApprovalBeforeExecutionHook, createToolRouterBeforeExecutionHook } from "./integration/approval-hook.js";

// 编辑处理器 Hook 工厂函数
export { createEditHandlerAfterExecutionHook } from "./integration/edit-handler-hook.js";

// V2 配置桥接（V2Config + mergeV2Config + V2ConfigError）
export { V2Config, V2ConfigError, mergeV2Config } from "./integration/settings-bridge.js";

// ============================================================================
// 8. observability 子模块 - V2 事件日志
// ============================================================================

export type {
  V2LogEventBase,
  ApprovalEvent,
  CompressionEvent,
  RetrievalEvent,
  SnapshotEvent,
  V2LogEvent,
} from "./observability/v2-events.js";
export { V2EventLogger } from "./observability/v2-events.js";
