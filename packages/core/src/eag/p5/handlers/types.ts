/**
 * EAG-P5 Phase 5.2 StageHandler 共享类型定义（TASK-P5-1.2-004~007）
 *
 * 本模块定义 4 个 StageHandler（plan/dev/verify/fix）共享的类型协议，
 * 是 AutonomousOrchestrator 4 阶段循环的类型契约基础。
 *
 * 核心类型：
 * 1. P5StageKind：4 阶段枚举（plan/dev/verify/fix）
 * 2. P5StageResultKind：4 类结果判定（success/failed/retriable/fatal）
 * 3. P5StageContext：阶段执行上下文（含护栏链 + 智能确认 + 运行状态）
 * 4. P5StageResult：阶段执行结果（含护栏记录 + 制品 + 耗时）
 * 5. P5StageHandler：阶段处理器协议（handle(ctx) → StageResult）
 *
 * 设计原则（对齐架构师审查 §4.1 + §5.12.4 G-A6d）：
 * - 不可变优先：所有字段 readonly，数组 ReadonlyArray<T>
 * - 零新增依赖：仅复用 Phase 5.1 类型 + node:* 内置模块
 * - 协议解耦：StageHandler 通过协议接口注入，不耦合具体实现
 * - 真实业务：handle() 返回 Promise，支持异步 LLM/git/test 调用
 *
 * 与 team/autonomous/loop-controller.ts 的差异：
 * - team 版 IterationContext：面向 RalphLoopController（含 agentOutput/tokenUsed）
 * - P5 版 P5StageContext：面向 AutonomousOrchestrator（含 guardChain/smartConfirmation）
 * - P5 版强化护栏集成：每个 StageHandler 必须调用 guardChain 做护栏判定
 *
 * @module eag/p5/handlers/types
 */

import type { BlockerGuardChain } from "../guards/blocker-guard-chain";
import type { GuardContext, GuardRecord, GuardVerdict, GuardChainResult } from "../guards/types";
import type { P5SmartConfirmation } from "../smart-confirmation";
import type { P5RunState, P5LoopType } from "../run-state-store";

// ============================================================================
// 1. 枚举类型（字面量联合 + Object.freeze）
// ============================================================================

/**
 * 4 阶段枚举（plan → dev → verify → fix）
 *
 * 对齐架构师审查 §5 时序图：每轮迭代按此顺序执行 4 个阶段。
 */
export type P5StageKind = "plan" | "dev" | "verify" | "fix";

/**
 * P5_STAGE_KINDS 全部合法值（用于运行时枚举与测试断言）
 *
 * 使用 Object.freeze 冻结，防止运行期被 LLM 自改（G-A6d）。
 */
export const P5_STAGE_KINDS: ReadonlyArray<P5StageKind> = Object.freeze(["plan", "dev", "verify", "fix"]);

/**
 * 阶段结果判定（4 类）
 *
 * - success：阶段成功完成，可进入下一阶段
 * - failed：阶段失败，需进入 fix 阶段或重试当前迭代
 * - retriable：可重试失败（如网络抖动），退避后重试
 * - fatal：不可恢复失败（如护栏 BLOCKER 触发），立即中止迭代
 *
 * 对齐 team/autonomous/loop-controller.ts 的 IterationKind。
 */
export type P5StageResultKind = "success" | "failed" | "retriable" | "fatal";

/**
 * P5_STAGE_RESULT_KINDS 全部合法值（用于运行时枚举与测试断言）
 */
export const P5_STAGE_RESULT_KINDS: ReadonlyArray<P5StageResultKind> = Object.freeze([
  "success",
  "failed",
  "retriable",
  "fatal",
]);

// ============================================================================
// 2. 阶段执行上下文（P5StageContext）
// ============================================================================

/**
 * 阶段执行上下文（不可变）
 *
 * 由 AutonomousOrchestrator 在每轮迭代中构造，传入 StageHandler.handle()。
 * 包含阶段执行所需的全部依赖：护栏链、智能确认、运行状态、笔记快照等。
 *
 * 字段全部 readonly——上下文一经构造即不可变，避免阶段间状态污染。
 *
 * 范例：
 *   {
 *     runId: "a1b2c3d4e5f6",
 *     iterIndex: 3,
 *     stage: "dev",
 *     projectRoot: "/path/to/project",
 *     worktreePath: "/path/to/project",
 *     objective: "为订单服务加退款功能",
 *     currentPlan: "T-001: 实现 refund() 方法",
 *     notesSnapshot: "## iter=2 stage=verify\n- 测试通过\n",
 *     prevResults: [...],
 *     runState: { ... },
 *     guardChain: blockerGuardChain,
 *     smartConfirmation: p5SmartConfirmation,
 *     tasksFilePath: "/path/to/project/.eag/p5/tasks.md",
 *     testCommand: "npm test",
 *     testTimeoutSec: 600,
 *     loopType: "coding"
 *   }
 */
export interface P5StageContext {
  /** run-id（12 位 UUID 前缀） */
  readonly runId: string;
  /** 当前迭代号（0-based） */
  readonly iterIndex: number;
  /** 当前阶段（plan/dev/verify/fix） */
  readonly stage: P5StageKind;
  /** 项目根目录（绝对路径） */
  readonly projectRoot: string;
  /** 工作树路径（git worktree，通常等于 projectRoot） */
  readonly worktreePath: string;
  /** 用户目标文本（如"为订单服务加退款功能"） */
  readonly objective: string;
  /** 当前计划（plan 阶段产出的任务卡描述，dev/verify/fix 阶段消费） */
  readonly currentPlan: string;
  /** 笔记快照（notes.md 的完整内容，跨轮记忆） */
  readonly notesSnapshot: string;
  /** 前序阶段结果（同迭代内已完成的阶段结果，按顺序） */
  readonly prevResults: ReadonlyArray<Readonly<P5StageResult>>;
  /** 当前运行状态（P5RunState 快照，readonly） */
  readonly runState: Readonly<P5RunState>;
  /** 护栏守护链（系统级 6 层 15 条 BLOCKER） */
  readonly guardChain: BlockerGuardChain;
  /** 智能确认器（命令级三态决策） */
  readonly smartConfirmation: P5SmartConfirmation;
  /** tasks.md 文件路径（plan 阶段读取任务卡） */
  readonly tasksFilePath: string;
  /** 测试命令（verify 阶段执行，如 "npm test"） */
  readonly testCommand: string;
  /** 测试超时（秒，verify 阶段使用） */
  readonly testTimeoutSec: number;
  /** 当前 Loop 类型（design/coding/testing/deploy） */
  readonly loopType: P5LoopType;
}

// ============================================================================
// 3. 阶段执行结果（P5StageResult）
// ============================================================================

/**
 * 阶段执行结果（不可变）
 *
 * 由 StageHandler.handle() 返回，包含阶段执行的完整产出：
 * 结果判定、摘要、制品、护栏记录、token 消耗、耗时。
 *
 * 字段全部 readonly——结果一经产出即不可变，供下游阶段与 Orchestrator 消费。
 *
 * 范例：
 *   {
 *     kind: "success",
 *     stage: "verify",
 *     summary: "测试通过：12 passed / 0 failed / 2 skipped",
 *     artifacts: { test_results: [12, 0, 2], diff_stats: [120, 30, 5] },
 *     guardRecords: [],
 *     tokensUsed: 0,
 *     durationMs: 4500
 *   }
 */
export interface P5StageResult {
  /** 结果判定（success/failed/retriable/fatal） */
  readonly kind: P5StageResultKind;
  /** 当前阶段 */
  readonly stage: P5StageKind;
  /** 结果摘要（人类可读，含关键指标） */
  readonly summary: string;
  /** 制品（key-value，含测试结果、diff 统计、任务卡等） */
  readonly artifacts: Readonly<Record<string, unknown>>;
  /** 错误信息（kind !== "success" 时填写） */
  readonly error?: string;
  /** 触发的护栏记录（含 BLOCKER 与 MAJOR，用于审计） */
  readonly guardRecords: ReadonlyArray<GuardRecord>;
  /** token 消耗（本阶段 LLM 调用累计，0=无 LLM 调用） */
  readonly tokensUsed: number;
  /** 执行耗时（毫秒） */
  readonly durationMs: number;
}

/**
 * 工厂函数：创建成功的 P5StageResult
 *
 * @param stage 阶段
 * @param summary 摘要
 * @param artifacts 制品（可选）
 * @param guardRecords 护栏记录（可选）
 * @param tokensUsed token 消耗（可选，默认 0）
 * @param durationMs 耗时（可选，默认 0）
 * @returns 冻结的 P5StageResult
 */
export function createSuccessStageResult(
  stage: P5StageKind,
  summary: string,
  artifacts: Readonly<Record<string, unknown>> = {},
  guardRecords: ReadonlyArray<GuardRecord> = [],
  tokensUsed: number = 0,
  durationMs: number = 0
): Readonly<P5StageResult> {
  return Object.freeze({
    kind: "success" as const,
    stage,
    summary,
    artifacts,
    guardRecords,
    tokensUsed,
    durationMs,
  });
}

/**
 * 工厂函数：创建失败的 P5StageResult
 *
 * @param stage 阶段
 * @param kind 失败类型（failed/retriable/fatal）
 * @param summary 摘要
 * @param error 错误详情
 * @param artifacts 制品（可选）
 * @param guardRecords 护栏记录（可选）
 * @param tokensUsed token 消耗（可选，默认 0）
 * @param durationMs 耗时（可选，默认 0）
 * @returns 冻结的 P5StageResult
 */
export function createFailedStageResult(
  stage: P5StageKind,
  kind: "failed" | "retriable" | "fatal",
  summary: string,
  error: string,
  artifacts: Readonly<Record<string, unknown>> = {},
  guardRecords: ReadonlyArray<GuardRecord> = [],
  tokensUsed: number = 0,
  durationMs: number = 0
): Readonly<P5StageResult> {
  return Object.freeze({
    kind,
    stage,
    summary,
    artifacts,
    error,
    guardRecords,
    tokensUsed,
    durationMs,
  });
}

// ============================================================================
// 4. StageHandler 协议接口
// ============================================================================

/**
 * 阶段处理器协议
 *
 * 所有 4 个 StageHandler（plan/dev/verify/fix）必须实现此接口。
 *
 * 协议约束：
 * 1. handle() 必须返回 Promise（支持异步 LLM/git/test 调用）
 * 2. handle() 必须在业务逻辑前调用 guardChain.execute() 做护栏判定
 * 3. handle() 返回的 P5StageResult 必须是冻结对象（Object.freeze）
 * 4. handle() 不得修改 ctx（context 是 readonly）
 *
 * 对齐架构师审查 §4.1 AutonomousOrchestrator 接口契约。
 */
export interface P5StageHandler {
  /**
   * 执行阶段处理
   *
   * @param ctx 阶段执行上下文（readonly）
   * @returns 阶段执行结果（Promise，冻结对象）
   */
  handle(ctx: Readonly<P5StageContext>): Promise<Readonly<P5StageResult>>;
}

// ============================================================================
// 5. 辅助类型（GuardContext 构造器）
// ============================================================================

/**
 * 从 P5StageContext 构造 GuardContext 的辅助函数
 *
 * StageHandler 在调用 guardChain.execute() 前需要构造 GuardContext，
 * 此函数提供默认值映射，避免每个 Handler 重复构造。
 *
 * @param ctx 阶段执行上下文
 * @param overrides 覆盖字段（可选）
 * @returns GuardContext（readonly）
 */
export function buildGuardContext(
  ctx: Readonly<P5StageContext>,
  overrides: Partial<GuardContext> = {}
): Readonly<GuardContext> {
  return Object.freeze({
    runId: ctx.runId,
    iterIndex: ctx.iterIndex,
    stage: ctx.stage,
    loopType: ctx.loopType,
    projectRoot: ctx.projectRoot,
    worktreePath: ctx.worktreePath,
    confirmationCardAccepted: true,
    emergencyStopRequested: false,
    loopGuardConfig: Object.freeze({
      maxIterations: ctx.runState.maxIterations,
      maxTokens: ctx.runState.maxTokens,
      maxConsecutiveFailures: 3,
    }),
    ...overrides,
  });
}

/**
 * 把 GuardChainResult 转换为 GuardRecord 数组的辅助函数
 *
 * 仅记录"被触发"的护栏（triggeredGuards，即 decision !== "PASS" 的判定），
 * 用于审计与 events.jsonl 持久化。
 *
 * @param chainResult 守护链执行结果
 * @param iterIndex 迭代号
 * @param stage 当前阶段（plan/dev/verify/fix）
 * @param loopType 当前 Loop 类型（design/coding/testing/deploy）
 * @returns GuardRecord 数组（readonly，冻结）
 */
export function toGuardRecords(
  chainResult: Readonly<GuardChainResult>,
  iterIndex: number,
  stage: P5StageKind,
  loopType: P5LoopType
): ReadonlyArray<GuardRecord> {
  const records: GuardRecord[] = [];
  for (const verdict of chainResult.triggeredGuards) {
    // ruleId 与 severity 在 PASS 时为空字符串，但 triggeredGuards 仅含非 PASS 判定，
    // 此处做兜底保护（若 verdict 为 PASS 则跳过）
    if (verdict.decision === "PASS") {
      continue;
    }
    records.push({
      triggeredAt: verdict.timestamp,
      ruleId: verdict.ruleId === "" ? "G-A2a" : verdict.ruleId,
      severity: verdict.severity === "" ? "MAJOR" : verdict.severity,
      decision: verdict.decision,
      reason: verdict.reason,
      iterIndex,
      stage,
      loopType,
    });
  }
  return Object.freeze(records);
}
