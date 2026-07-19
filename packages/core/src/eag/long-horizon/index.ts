/**
 * 长程自动化（long-horizon）模块入口 —— EAG-P3 批次 10
 *
 * 本 barrel 文件统一导出长程自动化所需的全部公开 API：
 * - 数据模型（types.ts）：RunState / MilestoneRecord / BlockageReport / MultiLoopPlan 等
 * - RunState 持久化（run-state-store.ts）：RunStateStore + FileLockProvider + SHA256 累积校验
 * - 多 Loop 串联计划生成器（multi-loop-planner.ts）：MultiLoopPlanner + DAG 校验
 * - /eag-run 命令处理器（eag-run-handler.ts）：EagRunHandler + LoopExecutor 协议
 * - /eag-resume 命令处理器（eag-resume-handler.ts）：EagResumeHandler + 断点恢复
 * - /eag-status 命令处理器（eag-status-handler.ts）：EagStatusHandler + Markdown 报告
 * - 里程碑 tag 生成器（milestone-tagger.ts）：MilestoneTagger + HealthScoreCalculator
 * - 阻塞分析器（blockage-analyzer.ts）：BlockageAnalyzer + RootCauseRuleMatcher
 *
 * 设计依据：EAG-P3 批次 10 设计文档 §4.9~§4.17
 *
 * 不可变优先原则（对齐 §5.12.4 G-A6d）：
 * - 所有接口字段使用 readonly 修饰
 * - 数组使用 ReadonlyArray<T>
 * - 顶层常量使用 Object.freeze 冻结
 *
 * @module eag/long-horizon
 */

// ============================================================================
// 1. 数据模型与常量（types.ts）
// ============================================================================

// 状态字面量联合类型
export type {
  RunStateStatus,
  MultiLoopNodeStatus,
  LoopPhase,
  RootCauseSource,
  SolutionCost,
  MultiLoopFinalStatus,
  MultiLoopNodeFinalStatus,
} from "./types";

// 接口（数据模型）
export type {
  RunState,
  MilestoneRecord,
  RegressionResult,
  HumanInterventionRecord,
  MultiLoopPlan,
  MultiLoopNode,
  LoopTransition,
  BlockageReport,
  RootCauseHypothesis,
  SuggestedSolution,
  RequiredDecision,
  DecisionOption,
  RootCauseRule,
  DagValidationResult,
  MultiLoopRunReport,
  MultiLoopNodeResult,
} from "./types";

// 常量
export {
  RUN_STATE_STATUSES,
  MULTI_LOOP_NODE_STATUSES,
  LOOP_PHASES,
  DEFAULT_LOOP_TRANSITIONS,
  ROOT_CAUSE_SOURCES,
  SOLUTION_COSTS,
  DEFAULT_ROOT_CAUSE_RULES,
  BLOCKAGE_TRIGGER_HUMAN_INTERVENTION_THRESHOLD,
  LLM_INFERRED_CONFIDENCE_CAP,
  MULTI_LOOP_FINAL_STATUSES,
  MULTI_LOOP_NODE_FINAL_STATUSES,
  DEFAULT_MAX_MULTI_LOOP_ITERATIONS,
  DEFAULT_RUN_STATE_DIR,
  DEFAULT_MILESTONE_TAG_PREFIX,
  HEALTH_SCORE_WEIGHTS,
  LONG_HORIZON_DEFAULTS,
} from "./types";

// 日志回调类型
export type { LogCallback } from "./types";

// 复用 loop/models 的类型（透传导出）
export type { LoopType, LoopEvent, LoopRunReport } from "./types";

// ============================================================================
// 2. RunState 持久化（run-state-store.ts）
// ============================================================================

export type { RunStateStoreErrorKind, RunStateEventType } from "./run-state-store";
export {
  RunStateStoreError,
  RunStateCorruptedError,
  RunStateNotFoundError,
  RunStateAlreadyExistsError,
  RunStateDivergedError,
  RUN_STATE_EVENT_TYPES,
  FileLockProvider,
  RunStateStore,
} from "./run-state-store";
export type {
  RunStateEvent,
  RunStateEventInput,
  RunStateInitRequest,
  RunStateSummary,
  LockHandle,
  LockProvider,
} from "./run-state-store";

// ============================================================================
// 3. 多 Loop 串联计划生成器（multi-loop-planner.ts）
// ============================================================================

export type { MultiLoopPlannerErrorKind } from "./multi-loop-planner";
export { MultiLoopPlannerError, MultiLoopPlanner } from "./multi-loop-planner";
export type { MultiLoopPlanRequest, ModuleSplit } from "./multi-loop-planner";

// ============================================================================
// 4. /eag-run 命令处理器（eag-run-handler.ts）
// ============================================================================

export type { EagRunHandlerErrorKind } from "./eag-run-handler";
export { EagRunHandlerError, EagRunHandler } from "./eag-run-handler";
export type {
  LoopExecutionContext,
  LoopExecutionResult,
  LoopExecutor,
  EagRunRequest,
  EagRunResult,
} from "./eag-run-handler";

// ============================================================================
// 5. /eag-resume 命令处理器（eag-resume-handler.ts）
// ============================================================================

export type { EagResumeHandlerErrorKind } from "./eag-resume-handler";
export { EagResumeHandlerError, EagResumeHandler } from "./eag-resume-handler";
export type { EagResumeRequest } from "./eag-resume-handler";

// ============================================================================
// 6. /eag-status 命令处理器（eag-status-handler.ts）
// ============================================================================

export type { EagStatusHandlerErrorKind } from "./eag-status-handler";
export { EagStatusHandlerError, EagStatusHandler } from "./eag-status-handler";
export type { EagStatusRequest, EagStatusResult } from "./eag-status-handler";

// ============================================================================
// 7. 里程碑 tag 生成器（milestone-tagger.ts）
// ============================================================================

export type { MilestoneTaggerErrorKind, MilestoneTagRequest } from "./milestone-tagger";
export {
  MilestoneTaggerError,
  HealthScoreCalculator,
  MilestoneTagger,
  DEFAULT_REGRESSION_TEST_COMMAND,
  DEFAULT_REGRESSION_TEST_TIMEOUT_SEC,
  DEFAULT_REDLINE_PASS_RATE,
  DEFAULT_COVERAGE_RATE,
} from "./milestone-tagger";

// ============================================================================
// 8. 阻塞分析器（blockage-analyzer.ts）
// ============================================================================

export type { BlockageAnalyzerErrorKind, BlockageAnalyzeRequest } from "./blockage-analyzer";
export { BlockageAnalyzerError, RootCauseRuleMatcher, BlockageAnalyzer } from "./blockage-analyzer";
