/**
 * CODING Loop 子模块 Barrel 导出（EAG-P2 批次 9 S1 基础层 + S3 核心组件层）
 *
 * 本文件对应 EAG-P2 批次 9 设计 §2 模块划分总览中的 `coding/index.ts`：
 * 统一导出 CODING Loop 全部公共 API，便于上层模块（如 session.ts、coding-orchestrator.ts）
 * 从单一入口导入。
 *
 * 当前已覆盖批次导出范围：
 * - S1 基础层：
 *   - coding/types.ts：CODING Loop 全部数据模型（接口、类型、常量、工厂函数、错误类）
 *   - coding/templates/index.ts：模板注册表（DEFAULT_TEMPLATE_REGISTRY + 13 种 EJS 模板）
 * - S3 核心组件层：
 *   - coding/skeleton-generator.ts：Phase A 骨架生成器（SkeletonGenerator + PlanParser + SkeletonGeneratorError）
 *   - coding/context-assembler.ts：上下文装配器（ContextAssembler + ContextAssemblerError）
 *   - coding/strict-evaluator.ts：STRICT 评估器（StrictEvaluator + StrictEvaluatorError）
 *
 * 后续批次（S4~S5）将继续扩展导出：
 * - S4：llm-filler.ts / fix-loop.ts
 * - S5：coding-orchestrator.ts（编排器）
 *
 * 设计原则：
 * - Barrel 模式：单一入口，避免散落导入
 * - 显式导出：避免命名冲突，便于 IDE 自动补全
 * - 类型与值分离：type-only 导出用 `export type`，运行时导出用 `export`
 *
 * @module eag/coding
 */

// ============================================================================
// 1. 导出 CODING Loop 数据模型（types.ts）
// ============================================================================

// 1.1 类型与接口导出（type-only）
export type {
  // 文件类型与生成产出
  GeneratedFileKind,
  GeneratedFile,
  // Phase A 骨架生成
  SkeletonGenerationRequest,
  SkeletonGenerationResult,
  FillPlaceholderKind,
  FillPlaceholder,
  // Phase B LLM 填充
  LlmFillRequest,
  LlmFillResult,
  FillStatusValue,
  FillStatus,
  // CODING Loop 上下文
  CodingContext,
  SemanticSearchHit,
  TcsSpecSummary,
  RlisRuleSummary,
  // STRICT 评估
  StrictEvaluationRequest,
  // FIX 回灌
  FixLoopRequest,
  FixLoopResult,
  FixRoundRecord,
  // CODING Loop 编排
  CodingLoopFinalStatus,
  TaskCodingStatus,
  CodingLoopRequest,
  CodingLoopResult,
  TaskCodingResult,
  // PKC 知识库访问器协议
  PkcAccessor,
  // 模板注册表协议
  TemplateRegistry,
  TemplateVariableSchema,
  // 评估器类型复用
  EvaluationContext,
  EvaluationMode,
} from "./types";

// 1.2 常量导出（运行时）
export {
  // 文件类型枚举
  GENERATED_FILE_KINDS,
  // 占位类型枚举
  FILL_PLACEHOLDER_KINDS,
  // 填充状态枚举
  FILL_STATUS_VALUES,
  // Loop 最终状态枚举
  CODING_LOOP_FINAL_STATUSES,
  // 任务卡执行状态枚举
  TASK_CODING_STATUSES,
  // 默认配置常量
  DEFAULT_MAX_FILL_ROUNDS,
  DEFAULT_MAX_TOKENS_PER_FILE,
  DEFAULT_MAX_FIX_ROUNDS,
  DEFAULT_MAX_CODING_ITERATIONS,
  DEFAULT_CODE_GENERATION_TEMPERATURE,
  DEFAULT_MAX_TOKENS_PER_LLM_CALL,
  DEFAULT_L2_SEARCH_TOP_K,
  L2_SCORE_FILTER_THRESHOLD,
  FIX_CONTEXT_WINDOW_SIZE,
  SAME_REDLINE_CONSECUTIVE_VIOLATION_LIMIT,
  CODING_DEFAULTS,
} from "./types";

// 1.3 工厂函数与错误类导出（运行时）
export {
  createSkeletonGenerationRequest,
  createLlmFillRequest,
  createCodingLoopRequest,
  SkeletonRequestError,
  LlmFillRequestError,
  CodingLoopRequestError,
} from "./types";

// ============================================================================
// 2. 导出模板注册表（templates/index.ts）
// ============================================================================

// 2.1 模板注册表与便捷函数
export { DEFAULT_TEMPLATE_REGISTRY, getTemplate } from "./templates/index";

// 2.2 模板字符串常量（供需要直接访问的调用方使用）
export {
  AGGREGATE_TEMPLATE,
  VALUE_OBJECT_TEMPLATE,
  DOMAIN_EVENT_TEMPLATE,
  DOMAIN_SERVICE_TEMPLATE,
  REPOSITORY_PORT_TEMPLATE,
  REPOSITORY_IMPL_TEMPLATE,
  APPLICATION_SERVICE_TEMPLATE,
  DTO_TEMPLATE,
  REST_CONTROLLER_TEMPLATE,
  SAGA_ORCHESTRATOR_TEMPLATE,
  EVENT_HANDLER_TEMPLATE,
  TEST_SPEC_TEMPLATE,
  MODULE_INDEX_TEMPLATE,
} from "./templates/index";

// 注：TemplateRegistry 与 TemplateVariableSchema 类型已在 1.1 节从 ./types 导出，
// templates/index.ts 仅作为内部模块使用，无需再次重新导出。

// ============================================================================
// 3. 导出 S3 核心组件层（批次 9 S3）
// ============================================================================
//
// S3 核心组件层对应 EAG-P2 批次 9 设计 §4 CODING Loop 五阶段实现：
// - Phase A 骨架生成（skeleton-generator.ts）
// - Phase B 上下文装配（context-assembler.ts）
// - STRICT 评估（strict-evaluator.ts）
//
// 设计依据：
// - EAG-P2 批次 9 设计 §4.2 Phase A 骨架生成器
// - EAG-P2 批次 9 设计 §4.3 上下文装配器
// - EAG-P2 批次 9 设计 §4.5 STRICT 评估器
// - §5.12.4 G-A6d 配置冻结原则（不可变优先）
//
// 注：S4（llm-filler / fix-loop）与 S5（coding-orchestrator）由后续批次扩展导出。

// 3.1 Phase A 骨架生成器（from skeleton-generator.ts）
export { SkeletonGenerator, SkeletonGeneratorError, PlanParser } from "./skeleton-generator";

// 3.2 上下文装配器（from context-assembler.ts）
export { ContextAssembler, ContextAssemblerError } from "./context-assembler";

// 3.3 STRICT 评估器（from strict-evaluator.ts）
export { StrictEvaluator, StrictEvaluatorError } from "./strict-evaluator";

// ============================================================================
// 4. 导出 S4 填充与修复层（批次 9 S4）
// ============================================================================
//
// S4 填充与修复层对应 EAG-P2 批次 9 设计 §4.4 Phase B LLM 填充器 + §4.6 FIX 回灌循环：
// - LlmFiller：在 Phase A 骨架基础上调用 LLM 逐个填充 FillPlaceholder
// - InMemoryLLMClient：测试专用真实实现（非 mock），含默认响应生成器
// - FixLoop：基于 STRICT 评估报告调用 LLM 生成 unified diff 修复 patch
// - UnifiedDiffApplier：自实现 unified diff 应用器（不引入 patch 库）
//
// 设计依据：
// - EAG-P2 批次 9 设计 §4.4 Phase B LLM 填充器
// - EAG-P2 批次 9 设计 §4.6 FIX 回灌循环
// - §5.12.4 G-A6d 配置冻结原则（不可变优先）
// - §4.4.5 InMemoryLLMClient 设计（响应生成器是真实 TypeScript 函数，非 stub）

// 4.1 Phase B LLM 填充器（from llm-filler.ts）
export { LlmFiller, LlmFillerError, InMemoryLLMClient, defaultResponseGenerator } from "./llm-filler";

// 4.2 类型导出（LlmFiller 相关类型）
export type { ResponseGenerator } from "./llm-filler";

// 4.3 FIX 回灌循环（from fix-loop.ts）
export { FixLoop, FixLoopError, PatchApplyError, UnifiedDiffApplier } from "./fix-loop";

// 4.4 类型导出（FixLoop 相关接口）
export type { PatchApplier } from "./fix-loop";

// ============================================================================
// 5. 导出 S5 编排与集成层（批次 9 S5）
// ============================================================================
//
// S5 编排与集成层对应 EAG-P2 批次 9 设计 §4.7 CODING Loop 编排器：
// - CodingOrchestrator：编排 Phase A → Phase B → STRICT → FIX 循环，按任务 DAG
//   拓扑序执行各任务卡，集成 G-4/G-5 门禁与 LoopGuard 上限保护
// - CodingOrchestratorError：编排器异常（invalid-request / dependency-missing /
//   task-node-not-found / gate-context-error）
// - CodingOrchestratorDeps：依赖注入参数接口（含 7 个必填依赖 + 1 个可选 logger）
//
// 设计依据：
// - EAG-P2 批次 9 设计 §4.7 CODING Loop 编排器
// - EAG-P2 批次 9 设计 §4.7.3 编排时序（Mermaid 序列图）
// - EAG-P2 批次 9 设计 §4.8 G-4/G-5 门禁
// - §5.12.4 G-A6d 配置冻结原则（不可变优先）
// - 架构师关键修正：使用 LoopGuard.check() + recordIteration()（不发明 checkIteration()）

// 5.1 CODING Loop 编排器（from coding-orchestrator.ts）
export { CodingOrchestrator, CodingOrchestratorError } from "./coding-orchestrator";

// 5.2 类型导出（CodingOrchestrator 依赖注入接口）
export type { CodingOrchestratorDeps } from "./coding-orchestrator";
