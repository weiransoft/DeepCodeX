/**
 * 文档驱动开发 Loop 模块入口（EAG-P1 批次 5）
 *
 * 本模块是 EAG（企业应用生成）体系 §5.10 文档驱动开发 Loop 的统一对外入口，
 * 汇总 doc-driven 全部子模块的公开 API，作为外部消费者的唯一导入源。
 *
 * 设计依据：
 * - EAG 方案 §5.10 文档驱动开发 Loop 细化编排
 * - §5.10.1 三文档契约（spec → plan → tasks）+ 文档即门禁
 * - §5.10.2 任务分解规范（粒度/DAG/验收卡）
 * - §5.10.4 Git 过程管理自动化（分支模型/Commit 规范/快照与回滚/删除纪律）
 * - SEED-10 规则（需求文档先行 + 文件删除操作延迟到 Loop 收尾）
 *
 * 模块结构：
 * - types.ts：文档驱动数据模型（文档类型/状态/任务 DAG/Git 配置/宪法输入）
 * - document-state-machine.ts：DocumentStateMachine 类（状态机 + 工作流校验）
 * - task-decomposition.ts：TaskDecomposer 类（任务分解 DAG + 拓扑排序 + 并行检测）
 * - git-process-manager.ts：GitProcessManager 类（分支/提交/PR/删除纪律）
 * - constitution-builder.ts：buildConstitution 函数（CONSTITUTION.md 生成器）
 *
 * 公开 API（barrel 导出）：
 * - 类型：DocumentType / DocumentState / EagDocument / FunctionalRequirement /
 *         TaskNode / TaskDag / CommitType / GitProcessConfig / ConstitutionInput /
 *         NonNegotiableItems / WorkflowValidationResult / PrDescription / DagValidationResult
 * - 常量：DOCUMENT_TYPES / DOCUMENT_STATES / DOCUMENT_PATHS / COMMIT_TYPES /
 *         DEFAULT_GIT_PROCESS_CONFIG
 * - 工厂函数：createDefaultGitProcessConfig / createInitialDocument
 * - 类：DocumentStateMachine / TaskDecomposer / GitProcessManager
 * - 函数：buildConstitution
 * - 异常：DocumentStateMachineError / TaskDecompositionError / GitProcessError /
 *         GitProcessConfigError / ConstitutionBuilderError
 *
 * @module eag/doc-driven
 */

// ============================================================================
// 类型与常量（from types.ts）
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
} from "./types";

export {
  DOCUMENT_TYPES,
  DOCUMENT_STATES,
  DOCUMENT_PATHS,
  COMMIT_TYPES,
  DEFAULT_GIT_PROCESS_CONFIG,
  createDefaultGitProcessConfig,
  GitProcessConfigError,
} from "./types";

// ============================================================================
// 文档状态机（from document-state-machine.ts）
// ============================================================================

export { DocumentStateMachine, DocumentStateMachineError, createInitialDocument } from "./document-state-machine";

// ============================================================================
// 任务分解器（from task-decomposition.ts）
// ============================================================================

export { TaskDecomposer, TaskDecompositionError } from "./task-decomposition";

export type { DagValidationResult } from "./task-decomposition";

// ============================================================================
// Git 过程管理器（from git-process-manager.ts）
// ============================================================================

export { GitProcessManager, GitProcessError } from "./git-process-manager";

export type { PrDescription } from "./git-process-manager";

// ============================================================================
// CONSTITUTION.md 构建器（from constitution-builder.ts）
// ============================================================================

export { buildConstitution, ConstitutionBuilderError } from "./constitution-builder";

// ============================================================================
// plan.md 生成器（from plan-generator.ts）—— EAG-P2 批次 8 新增
// ============================================================================

export { PlanGenerator, PlanGeneratorError } from "./plan-generator";

export type { PlanGenerationInput, ModuleSplit, InterfaceContract, DataMigration, RiskItem } from "./types";

// ============================================================================
// tasks.md 生成器（from tasks-generator.ts）—— EAG-P2 批次 8 新增
// ============================================================================

export { TasksGenerator, TasksGeneratorError } from "./tasks-generator";

export type { TasksGenerationInput, TaskCard, TaskCardStatus } from "./types";

export { TASK_CARD_STATUSES } from "./types";
