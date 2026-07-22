/**
 * V2 上下文记忆体系 - 公共 API 聚合层
 *
 * 设计依据：
 * - V2_CONTEXT_MEMORY_TECH_DESIGN.md §14.5（V2 路线完成状态）
 * - 架构师审查报告（2026-07-21）：建议先建 v2/index.ts 中间聚合层，
 *   再由 packages/core/src/index.ts re-export，与 team/index.ts 风格一致
 *
 * 聚合范围（10 个子模块）：
 *   1. context     - 全局上下文 / 双层管理器 / 滑动窗口 / 渐进加载 / 相关性评分 / 同步器
 *   2. memory      - 记忆存储 / 项目记忆 / 隐私管理 / 摘要器 / 经验推荐 / 用户全局记忆
 *   3. codemap     - 代码地图生成器 / 文件监视器 / 正则分析器
 *   4. understanding - 项目理解 / 业务领域建模
 *   5. diff        - Myers diff / 补丁应用 / 补丁摘要 / Diff 预览增强
 *   6. approval    - 审批门 / 命令安全 / Side Git / 工具路由 / 恢复
 *   7. integration - 会话 Hook / 审批 Hook / 编辑 Hook / 设置桥接
 *   8. observability - V2 事件日志
 *   9. EAG-P6 Phase 1 - SymbolGraphAdapter 适配层 + 降级实现（V2-P4 图谱适配层）
 *  10. EAG-P6 Phase 2 - CodeMapSnippetProvider + DynamicWindowManager（DW-1~DW-4 四层供给）
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

// ============================================================================
// 9. EAG-P6 Phase 1 - SymbolGraphAdapter 适配层 + 降级实现
// ============================================================================
//
// 设计依据：
// - EAG-P6-REQUIREMENTS.md §3 FR-7（CodeMap 降级探测）+ §4 NFR-4（降级零回归）
// - EAG-P6-ARCHITECTURE.md §5.2 接口契约 5（SymbolGraphAdapter）
//   + §11.3 V2-P4 未实施时的降级路径
// - EAG-P6-TASKS.md §3 TASK-P6-1-01/02（Phase 1 模块清单 + barrel 导出）
//
// 命名冲突处理（重要）：
// - symbol-graph-types.ts 的 SymbolKind / SYMBOL_KINDS 与 eag/pkc/l2-types.ts 同名
//   但语义不同：
//   - L2 SymbolKind（eag/pkc/l2-types.ts）：索引器粒度，8 种语法类别
//     （class/function/method/interface/variable/enum/type-alias/property）
//   - P6 SymbolKind（v2/context/symbol-graph-types.ts）：图谱节点粒度，7 种节点类别
//     （function/class/interface/type/variable/module/namespace）
// - 两者均通过 core/index.ts 对外导出，为避免命名冲突，P6 版本重命名为：
//   - SymbolKind → GraphSymbolKind（图谱符号类型）
//   - SYMBOL_KINDS → GRAPH_SYMBOL_KINDS（图谱符号类型常量）
// - 调用方使用 GraphSymbolKind / GRAPH_SYMBOL_KINDS 访问 P6 图谱版本
// - 直接从 v2/context/symbol-graph-types.ts 导入仍可使用原名 SymbolKind / SYMBOL_KINDS
//
// 降级保证（NFR-4 零回归）：
// - V2-P4 图谱模块未实施时，isGraphStoreAvailable() 返回 false
// - DefaultSymbolGraphAdapter 在 isGraphStoreAvailable() 返回 false 时
//   所有方法返回空数组（静默降级，不抛错，不打印 warning）
// - 行为与 V2-P3 完全一致（文件级评分 + PCL 三层），零回归

// 适配层接口与降级探测函数（symbol-graph-adapter.ts）
export type { SymbolGraphAdapter } from "./context/symbol-graph-adapter.js";
export {
  isGraphStoreAvailable,
  resetGraphStoreAvailabilityCache,
  EMPTY_SYMBOL_RECORDS,
  EMPTY_EDGE_RECORDS,
} from "./context/symbol-graph-adapter.js";

// 默认降级实现（default-symbol-graph-adapter.ts）
// - isAvailable() 始终返回 false，所有查询方法返回空数组
// - 静默降级，不抛错，不打印 warning
export { DefaultSymbolGraphAdapter } from "./context/default-symbol-graph-adapter.js";

// 静态图谱实现（static-symbol-graph.ts）
// - 基于 Map + BFS 的真实降级实现（禁 mock）
// - 构造时注入 StaticGraphData，构建内存索引
// - 提供真实的 queryByName / queryByKind / getEdges / getExplosionRadius /
//   getRiskHotspots / searchByQuery 实现
export { StaticSymbolGraph } from "./context/static-symbol-graph.js";

// 共享类型定义（symbol-graph-types.ts）
// 注：SymbolKind / SYMBOL_KINDS 重命名为 GraphSymbolKind / GRAPH_SYMBOL_KINDS，
// 避免与 eag/pkc/l2-types.ts 的同名类型冲突（语义不同，分别定义）
export type {
  EdgeDirection,
  EdgeKind,
  Confidence,
  SymbolRecord,
  EdgeRecord,
  StaticGraphData,
  SymbolKind as GraphSymbolKind,
} from "./context/symbol-graph-types.js";
export {
  EDGE_DIRECTIONS,
  EDGE_KINDS,
  CONFIDENCE_LEVELS,
  CONFIDENCE_WEIGHTS,
  SYMBOL_KINDS as GRAPH_SYMBOL_KINDS,
} from "./context/symbol-graph-types.js";

// ============================================================================
// 10. EAG-P6 Phase 2 - CodeMapSnippetProvider + DynamicWindowManager
// ============================================================================
//
// 设计依据：
// - EAG-P6-REQUIREMENTS.md §3 FR-1（DynamicWindowManager）/ FR-2（CodeMapSnippetProvider）
//   + DW-1~DW-4 四层供给策略
// - EAG-P6-ARCHITECTURE.md §5.1 核心数据模型 + §5.2 接口契约 1/2
//   + §6 数据流图（DW-1~DW-4 四层供给）
// - EAG-P6-TASKS.md §3 TASK-P6-2-01/02/03/04（Phase 2 模块清单 + barrel 导出）
//
// 降级保证（NFR-4 零回归）：
// - V2-P4 图谱模块未实施时，isGraphStoreAvailable() 返回 false
// - CodeMapSnippetProvider 各方法返回空数组（静默降级，不抛错）
// - DynamicWindowManager.computeWindow 返回 EMPTY_DYNAMIC_WINDOW_RESULT
// - 行为与 V2-P3 完全一致（文件级评分 + PCL 三层），零回归

// 动态窗口共享类型与常量（dynamic-window-types.ts）
export type {
  LoopPhase,
  CodeMapSnippetType,
  DynamicWindowSource,
  CodeMapSnippet,
  DynamicWindowQuery,
  DynamicWindowResult,
  TokenBudgetAllocation,
} from "./context/dynamic-window-types.js";
export {
  LOOP_PHASES,
  CODEMAP_SNIPPET_TYPE,
  CODEMAP_SNIPPET_TYPES,
  DYNAMIC_WINDOW_SOURCES,
  CODEMAP_BUDGET_RATIO,
  OTHER_BUDGET_RATIO,
  MAX_DW1_SYMBOL_SNIPPETS,
  MAX_DW3_RISK_SNIPPETS,
  MAX_CODEMAP_TOOLS_PER_TURN,
  MAX_EXPLOSION_RADIUS_DEPTH,
  DEFAULT_EXPLOSION_RADIUS_DEPTH,
  DEFAULT_EXPLOSION_RADIUS_MAX_NODES,
  CHARS_PER_TOKEN,
  LOW_RELEVANCE_THRESHOLD,
  EMPTY_CODEMAP_SNIPPETS,
  EMPTY_DYNAMIC_WINDOW_RESULT,
  EMPTY_TOKEN_BUDGET_ALLOCATION,
} from "./context/dynamic-window-types.js";

// CodeMap 片段提供者（code-map-snippet-provider.ts）
// - DW-1 焦点符号直供（getDirectRetainSnippets）：上限 3 片段，必注入
// - DW-2 爆炸半径动态注入（getImpactSnippets）：参与评分竞争
// - DW-3 风险热点按需拉取（getRiskHotspotSnippets）：上限 5 片段
// - DW-4 语义检索即时查（searchByQuery）：agent tool 调用
// - 降级：isGraphStoreAvailable() 返回 false 时全部返回空数组
export { CodeMapSnippetProvider } from "./context/code-map-snippet-provider.js";

// 动态窗口管理器（dynamic-window-manager.ts）
// - 协调 DW-1~DW-3 按 LoopPhase 激活（DW-4 走 tool-executor 独立路径）
// - computeWindow：产出 DynamicWindowResult（已评分排序 + Token 截断 + 冻结）
// - allocateTokenBudget：30% codemap + 70% 其他
// - 降级：isGraphStoreAvailable() 返回 false 时返回 EMPTY_DYNAMIC_WINDOW_RESULT
export { DynamicWindowManager } from "./context/dynamic-window-manager.js";

// ============================================================================
// 11. EAG-P6 Phase 3 - FiveStagePromptAssembler + RolePromptCustomizer
//     + RoleSignalDetector + phaseKnowledgeSlice
// ============================================================================
//
// 设计依据：
// - EAG-P6-REQUIREMENTS.md §2 US-1/US-2/US-3（五段式 prompt + 角色定制 + 信号检测）
// - EAG-P6-ARCHITECTURE.md §5.2 接口契约 1/2/3（FiveStagePromptAssembler /
//   RoleSignalDetector / RolePromptCustomizer）+ §4 模块清单
// - EAG-P6-TASKS.md §3 TASK-P6-3-01/02/03/04/05（Phase 3 模块清单 + barrel 导出）
//
// 命名冲突处理（重要）：
// - role-signal-detector.ts 的 TaskContext 与 v2/context/types.ts 的 TaskContext 同名
//   但语义不同：
//   - v2/context/types.ts TaskContext：运行时任务上下文（含 taskId/taskDefinition/taskState）
//   - role-signal-detector.ts TaskContext：角色信号检测输入（含 title/description/focusPoints）
// - 两者均通过 v2/index.ts 对外导出，为避免命名冲突，role-signal-detector.ts 版本重命名为：
//   - TaskContext → RoleTaskContext（角色信号检测任务上下文）
// - 直接从 v2/prompt/role-signal-detector.ts 导入仍可使用原名 TaskContext
//
// LoopPhase 命名差异处理：
// - v2/context/dynamic-window-types.ts 的 LoopPhase 使用 "deploy"
// - v2/prompt/role-knowledge-slices.ts 的 RolePhase 使用 "handover"（语义更准确）
// - 通过 toV2LoopPhase() 映射函数转换
//
// 降级保证（NFR-4 零回归）：
// - role-signal-detector.ts 的语义匹配三级降级链：embedder → TFIDF → Hashing
// - 无 SymbolRecord.embedding 时降级到 TFIDF，TFIDF 失败降级到 Hashing
// - 行为与 Phase 1+2 一致，零回归

// 角色 phaseKnowledgeSlice 静态切片表（role-knowledge-slices.ts）
// - 5 角色 × 4 阶段 = 20 个 Object.freeze 切片
// - 每切片含 phaseGoal / keyChecks / commonPitfalls / outputFormat / historicalExperience
// - skill 融合关键内容：architect 含 "四步分析框架"，solo_coder 含 "NO PRODUCTION CODE..."
//   test_expert 含 "假设→插桩→复现→分析→修复→验证"，ui_designer 含 "反 AI-slop"
export type { RoleKind, RolePhase, PhaseKnowledgeSlice } from "./prompt/role-knowledge-slices.js";
export {
  ROLE_KINDS,
  ROLE_PHASES,
  PHASE_KNOWLEDGE_SLICES,
  toV2LoopPhase,
  getPhaseKnowledgeSlice,
  listAllPhaseKnowledgeSlices,
  listSlicesByRole,
  listSlicesByPhase,
} from "./prompt/role-knowledge-slices.js";

// 角色信号探测器（role-signal-detector.ts）
// - 三路检测：关键词匹配（5 角色关键词表）+ 语义匹配（embedder/TFIDF/Hashing 降级链）
//   + 任务类型推断（6 任务类型 → 主角色映射）
// - 综合置信度加权：keyword 0.5 + semantic 0.3 + task_type 0.2
// - 输出 RoleSignal[]，按综合置信度降序排序
// 注：TaskContext 重命名为 RoleTaskContext，避免与 v2/context/types.ts 的 TaskContext 冲突
export type {
  RoleSignalSource,
  TaskType,
  RoleSignal,
  TaskContext as RoleTaskContext,
  RoleSignalDetectorOptions,
  SemanticFallbackLevel,
} from "./prompt/role-signal-detector.js";
export {
  DEFAULT_DETECTOR_OPTIONS,
  ROLE_KEYWORDS,
  ROLE_DESCRIPTIONS,
  TASK_TYPE_TO_ROLE,
  TASK_TYPE_KEYWORDS,
  TASK_TYPES,
  inferTaskType,
  RoleSignalDetector,
  detectRoleSignals,
} from "./prompt/role-signal-detector.js";

// 角色 prompt 定制器（role-prompt-customizer.ts）
// - 双接口：customize(role, phase) 单角色定制 / customizeFromSignals(signals, phase) 多角色定制
// - 主角色 + 协作角色（最多 2 个）+ phaseKnowledgeSlice 注入
// - 拼接 karpathyPreamble + roleIdentityPrompt + phaseKnowledgePrompt
export type { RolePromptCustomization, RolePromptCustomizerOptions } from "./prompt/role-prompt-customizer.js";
export {
  DEFAULT_CUSTOMIZER_OPTIONS,
  ROLE_IDENTITY_DESCRIPTIONS,
  RolePromptCustomizer,
  customizeRolePrompt,
  customizeRolePromptFromSignals,
} from "./prompt/role-prompt-customizer.js";

// 五段式 prompt 组装器（five-stage-prompt-assembler.ts）
// - 五段式：SystemConstraint(10%) / TaskContext(15%) / CodeMapSnippet(50%)
//   / HistoricalExperience(15%) / OutputRequirement(10%)
// - 默认总 Token 预算 4000（对齐 multi-agent-team skill Token 经济学）
// - 段内超出预算时截断并追加 "...[truncated]" 标记
// - 集成 RolePromptCustomization + DynamicWindowResult（可选）
export type {
  FiveStagePromptInput,
  TokenBudgetBreakdown,
  FiveStagePromptResult,
} from "./prompt/five-stage-prompt-assembler.js";
export {
  DEFAULT_TOTAL_TOKEN_BUDGET,
  FIVE_STAGE_RATIOS,
  FiveStagePromptAssembler,
  assembleFiveStagePrompt,
} from "./prompt/five-stage-prompt-assembler.js";

// ============================================================================
// 12. EAG-P6 Phase 4 - codemap_query / impact_analysis / flow_trace / risk_scan
//     工具 + tool-executor-registry
// ============================================================================
//
// 设计依据：
// - EAG-P6-REQUIREMENTS.md §3 FR-6（codemap 工具集）+ DW-2 爆炸半径 + DW-3 风险热点
//   + DW-4 即时查策略
// - EAG-P6-ARCHITECTURE.md §5.2 接口契约 5（SymbolGraphAdapter）
//   + §8.2.4 Phase 4 验收标准（4 工具全部注册到 tool-executor）
//   + §6 数据流图（DW-4 codemap_* 工具结果直接拼入 LLM messages）
// - EAG-P6-TASKS.md §3 TASK-P6-4-01/02/03/04（Phase 4 模块清单 + barrel 导出）
//
// 用户关键约束（任务规格强制）：
// - "禁止使用模拟，占位，mock，简化的方式开发代码"
// - "真实 BFS / DFS 实现（非 mock）"
// - 不可变优先：readonly + ReadonlyArray + Object.freeze
// - 中文详细注释，符合 Rust/Java 代码规范
//
// 4 个工具接口契约：
// - codemap_query：{ query / kind? / namespace? / limit? } → { symbols / total / queryTime }
// - impact_analysis：{ symbolId / direction / maxDepth? / maxNodes? } →
//                    { impactedSymbols / totalNodes / maxDepthReached / cycles }
// - flow_trace：{ startSymbolId / endSymbolId? / direction / maxDepth? } →
//               { paths / totalPaths / truncated }
// - risk_scan：{ threshold? / limit? / kind? } → { hotspots / totalHotspots / avgRiskScore }
//
// 降级保证（NFR-4 零回归）：
// - isGraphStoreAvailable() 返回 false 时，4 个工具全部返回空结果（不抛错）
// - adapter.isAvailable() 返回 false 时，4 个工具全部返回空结果
// - 行为与 V2-P3 完全一致（零回归）
//
// 兼容性保证（向后兼容 Phase 1-3）：
// - 不修改现有 ToolExecutor 类实现（仅通过 registerCodemapTools 注入 4 个 handler）
// - 不影响现有工具（bash / read / write / edit / AskUserQuestion / UpdatePlan / WebSearch）
// - 4 个 codemap 工具与现有工具并列，由 ToolExecutor 统一调度

// codemap_query 工具（DW-4 即时查符号查询）
// - 输入：{ query / kind? / namespace? / limit? }
// - 输出：{ symbols / total / queryTime }
// - 查询策略：query+kind / 仅 query / 仅 kind 三种组合 + namespace 前缀过滤
// - 降级：双层降级（graphAvailability + adapter.isAvailable）
export type { CodemapQueryInput, CodemapQueryResult } from "./tools/codemap-query-tool.js";
export {
  CODEMAP_QUERY_TOOL_NAME,
  CODEMAP_QUERY_TOOL_DESCRIPTION,
  DEFAULT_CODEMAP_QUERY_LIMIT,
  MAX_CODEMAP_QUERY_LIMIT,
  EMPTY_CODEMAP_QUERY_RESULT,
  CodemapQueryTool,
} from "./tools/codemap-query-tool.js";

// impact_analysis 工具（DW-2 爆炸半径 / 影响范围分析）
// - 输入：{ symbolId / direction: forward|backward|both / maxDepth? / maxNodes? }
// - 输出：{ impactedSymbols / totalNodes / maxDepthReached / cycles }
// - 算法：方向感知 BFS（forward=outgoing / backward=incoming / both=双向）
//   + 独立 DFS 循环检测（深度 ≤ MAX_CYCLE_DETECTION_DEPTH=10 + 环数 ≤ MAX_CYCLES=10）
// - 深度解耦：BFS maxDepth 受架构师硬约束 ≤3，循环检测独立深度 ≤10（允许检测典型环）
// - 降级：双层降级（graphAvailability + adapter.isAvailable）
export type { ImpactAnalysisInput, ImpactedSymbol, ImpactAnalysisResult } from "./tools/impact-analysis-tool.js";
export {
  IMPACT_ANALYSIS_TOOL_NAME,
  IMPACT_ANALYSIS_TOOL_DESCRIPTION,
  DEFAULT_IMPACT_ANALYSIS_MAX_DEPTH,
  MAX_IMPACT_ANALYSIS_MAX_DEPTH,
  DEFAULT_IMPACT_ANALYSIS_MAX_NODES,
  MAX_IMPACT_ANALYSIS_MAX_NODES,
  MAX_CYCLES,
  MAX_CYCLE_DETECTION_DEPTH,
  EMPTY_IMPACT_ANALYSIS_RESULT,
  ImpactAnalysisTool,
} from "./tools/impact-analysis-tool.js";

// flow_trace 工具（调用链路径枚举 / 控制流追踪）
// - 输入：{ startSymbolId / endSymbolId? / direction: forward|backward / maxDepth? }
// - 输出：{ paths / totalPaths / truncated }
// - 算法：方向感知 DFS 路径枚举（forward=outgoing / backward=incoming）
//   + 路径数 ≤ MAX_PATHS=20 + 深度 ≤ maxDepth
// - 降级：双层降级（graphAvailability + adapter.isAvailable）
export type { FlowTraceInput, CallPath, FlowTraceResult } from "./tools/flow-trace-tool.js";
export {
  FLOW_TRACE_TOOL_NAME,
  FLOW_TRACE_TOOL_DESCRIPTION,
  DEFAULT_FLOW_TRACE_MAX_DEPTH,
  MAX_FLOW_TRACE_MAX_DEPTH,
  MAX_PATHS,
  EMPTY_FLOW_TRACE_RESULT,
  FlowTraceTool,
} from "./tools/flow-trace-tool.js";

// risk_scan 工具（DW-3 风险热点扫描 / 高风险符号 Top-N）
// - 输入：{ threshold? / limit? / kind? }
// - 输出：{ hotspots / totalHotspots / avgRiskScore }
// - 算法：调用 getRiskHotspots(topN=200) + 阈值过滤 + kind 过滤 + limit 截断
// - 降级：双层降级（graphAvailability + adapter.isAvailable）
export type { RiskScanInput, RiskHotspot, RiskScanResult } from "./tools/risk-scan-tool.js";
export {
  RISK_SCAN_TOOL_NAME,
  RISK_SCAN_TOOL_DESCRIPTION,
  DEFAULT_RISK_SCAN_THRESHOLD,
  DEFAULT_RISK_SCAN_LIMIT,
  MAX_RISK_SCAN_LIMIT,
  EMPTY_RISK_SCAN_RESULT,
  RiskScanTool,
} from "./tools/risk-scan-tool.js";

// tool-executor-registry（4 个 codemap 工具注册到 ToolExecutor）
// - CodemapToolRegistry：持有 4 个工具实例，提供 ToolHandler 映射
// - registerCodemapTools(toolExecutor, adapter)：将 4 个 handler 注入 ToolExecutor
// - createCodemapToolHandlers(adapter)：返回 handler 映射（不依赖 ToolExecutor 实例）
// - ToolExecutorRegistrar：最小化注册接口（依赖倒置，便于测试与扩展）
// - CODEMAP_TOOL_METADATA：4 个工具元数据列表（name + description）
export type { CodemapToolMetadata, ToolExecutorRegistrar } from "./tools/tool-executor-registry.js";
export {
  CODEMAP_TOOL_METADATA,
  CodemapToolRegistry,
  registerCodemapTools,
  createCodemapToolHandlers,
} from "./tools/tool-executor-registry.js";
