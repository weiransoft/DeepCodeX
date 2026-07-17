/**
 * V1 依赖适配器（v1-adapters）
 *
 * V2.3 P1-05 修复：V2 → V1 依赖的唯一入口。
 *
 * 背景：V2 各模块（approval / diff / context / codemap / memory / integration）
 * 需要复用 V1 已有能力（语义嵌入、文件工具、智能确认、git 驱动、模式执行器、
 * 反馈控制环、Karpathy 原则、Ponytail 决策梯）。修复前 V2 模块直接
 * `import ... from "../../team/xxx"`，依赖面散落各处、不可审计。
 *
 * 本文件是 V2 模块引用 V1 依赖的唯一入口：
 * - 全量 re-export 8 个 V1 依赖模块中 V2 需要消费的公开 API；
 * - V2 模块只允许从本文件 import V1 能力（eslint no-restricted-imports 强制，
 *   见 eslint.config.mjs 的 v2 作用域规则）；
 * - 本文件只做 re-export，不含任何业务逻辑（integration 层边界约束：
 *   仅放 V1↔V2 适配代码，单文件 ≤ 200 行，超出即下沉到对应子域模块）。
 *
 * 命名冲突处理：V1 与 V2 存在同名类型时，V1 侧以 `V1` 前缀别名导出
 *（如 V1RiskLevel / GitDiffStats），避免与 V2 approval/types 的
 * RiskLevel（benign/caution/destructive）及 diff 模块的 DiffStats 混淆。
 *
 * 审计命令（验收标准）：
 * ```bash
 * grep -rn 'from "../../' packages/core/src/v2 --include="*.ts" \
 *   | grep -v v1-adapters | grep -v tests   # 必须无结果
 * ```
 */

// ============================================================================
// 1. common/tool-types（工具执行类型，类型级依赖）
// ============================================================================
// V2 钩子（edit-handler-hook / approval-hook）需要 ToolExecutionResult /
// ToolExecutionHooks 类型签名与 V1 ToolExecutor 契约对齐。
export type { ToolExecutionResult, ToolExecutionHooks, ToolExecutionContext, ToolCall } from "../../common/tool-types";

// ============================================================================
// 2. common/file-utils（文件读写与 diff 预览基础工具）
// ============================================================================
// V2 diff 增强复用 buildDiffPreview 作为降级输出；记忆/上下文模块复用
// readTextFileWithMetadata / writeTextFile 做安全的文件读写。
export {
  buildDiffPreview,
  normalizeContent,
  detectLineEndings,
  detectEncoding,
  readTextFileWithMetadata,
  writeTextFile,
  ensureParentDirectory,
} from "../../common/file-utils";
export type { FileReadMetadata } from "../../common/file-utils";

// ============================================================================
// 3. team/workflows/semantic-embedder（语义嵌入：TF-IDF / Hashing）
// ============================================================================
// V2 经验检索（ADR-V2-002）复用 TF-IDF / Hashing Embedder，不引入向量数据库。
export {
  cosineSimilarity,
  tokenize,
  TFIDFEmbedder,
  HashingEmbedder,
  EmbeddingCache,
  getDefaultEmbedder,
  resetDefaultEmbedder,
  createEmbedder,
} from "../../team/workflows/semantic-embedder";
export type {
  EmbedderLike,
  TFIDFEmbedderConfig,
  HashingEmbedderConfig,
  EmbeddingCacheConfig,
} from "../../team/workflows/semantic-embedder";

// ============================================================================
// 4. team/autonomous/smart-confirmation（V1 智能确认三态决策）
// ============================================================================
// V2 ApprovalGate 在 autonomous 模式下复用 SmartConfirmation（§9.3 职责分工：
// SmartConfirmation 仅服务 V1 autonomous 模式；黑名单/白名单数据单一事实源
// 位于 v2/approval/command-safety.ts）。
// 注意：V1 RiskLevel（low/medium/high/critical）与 V2 RiskLevel
//（benign/caution/destructive）语义不同，以 V1RiskLevel 别名导出防混淆。
export { SmartConfirmation, scoreToLevel } from "../../team/autonomous/smart-confirmation";
export type {
  RiskLevel as V1RiskLevel,
  ConfirmationDecision,
  ConfirmationResult,
} from "../../team/autonomous/smart-confirmation";

// ============================================================================
// 5. team/autonomous/git-driver（git 操作驱动）
// ============================================================================
// V2 side-git（ADR-V2-003）复用 GitDriver 的 child_process git 调用能力。
// 注意：V1 DiffStats（git diff 统计）与 V2 diff 模块的 DiffStats 结构不同，
// 以 GitDiffStats 别名导出防混淆。
export { GitDriver, defaultGitOpResult, defaultDiffStats } from "../../team/autonomous/git-driver";
export type { GitOpResult, DiffStats as GitDiffStats } from "../../team/autonomous/git-driver";

// ============================================================================
// 6. team/workflows/pattern-executor（工作流模式执行器）
// ============================================================================
// V2 编排层复用模式执行器工厂（分类派发 / 扇出聚合 / 对抗验证等模式）。
export {
  PatternExecutorFactory,
  createDefaultExecutor,
  defaultExecutionContext,
} from "../../team/workflows/pattern-executor";
export type {
  PatternExecutorLike,
  PatternExecutorResult,
  ExecutionContext as PatternExecutionContext,
  DispatchFn,
} from "../../team/workflows/pattern-executor";

// ============================================================================
// 7. team/cybernetics/feedback-control-loop（反馈控制环）
// ============================================================================
// V2 记忆体系的经验强化学习复用反馈控制环（采集 → 估计 → 策略调整）。
export {
  FeedbackControlLoop,
  ControlPhase,
  ALL_CONTROL_PHASES,
  isValidControlPhase,
} from "../../team/cybernetics/feedback-control-loop";
export type {
  FeedbackControlLoopConfig,
  ExecutionCase,
  Feedback,
  ControlState,
} from "../../team/cybernetics/feedback-control-loop";

// ============================================================================
// 8. team/principles/karpathy（Karpathy 四大核心原则）
// ============================================================================
// V2 各模块系统提示词注入复用 Karpathy 原则文本（§1.1 强制执行）。
export {
  KARPATHY_PRINCIPLE_IDS,
  ALL_KARPATHY_PRINCIPLES,
  isValidKarpathyPrinciple,
  getKarpathyPrinciples,
  getKarpathyPrinciple,
  getKarpathyPrincipleName,
  KARPATHY_4_PRINCIPLES_FULL,
} from "../../team/principles/karpathy";
export type { KarpathyPrincipleId } from "../../team/principles/karpathy";

// ============================================================================
// 9. team/principles/ponytail（Ponytail 决策梯与红线）
// ============================================================================
// V2 审批门红线复核（§14.4）复用 Ponytail 红线清单与决策梯规则引擎。
export {
  PonytailMode,
  ALL_PONYTAIL_MODES,
  isValidPonytailMode,
  ponytailModeFromStr,
  PonytailRulesetEngine,
  DEFAULT_PONYTAIL_ENGINE,
  RED_LINE_LIST,
  LADDER_BODY,
  RED_LINES,
} from "../../team/principles/ponytail";
export type { PonytailModeType } from "../../team/principles/ponytail";

// ============================================================================
// 10. session（V1 会话消息类型）
// ============================================================================
// V2 集成钩子（session-hook）需要 SessionMessage 类型用于 preBuildContext
// 参数签名。V2 模块禁止直接 import V1 文件，经此 re-export 暴露。
export type { SessionMessage } from "../../session";
