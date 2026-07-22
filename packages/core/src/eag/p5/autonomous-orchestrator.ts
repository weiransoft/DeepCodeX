/**
 * EAG-P5 Phase 5.2 AutonomousOrchestrator 主控制器（TASK-P5-1.2-009）
 *
 * 本模块实现 `AutonomousOrchestrator` 类，是 EAG-P5 无人值守引擎的"薄编排层"，
 * 在 P5RunStateStore / P5NotesMemory / P5SmartConfirmation / 4 个 StageHandler /
 * BlockerGuardChain / P5LoopExecutor 之上叠加 4 阶段循环调度逻辑。
 *
 * 核心职责（对齐架构师审查 §4.1 + §2.1.3 + 用户任务说明）：
 * 1. 接收 AutonomousRunRequest，初始化 RunState 持久化存储
 * 2. 进入 4 阶段循环：plan → dev → verify → fix（每轮迭代 4 个阶段）
 * 3. 通过 P5LoopExecutor 分流到对应 StageHandler 执行
 * 4. 每阶段后保存 RunState 快照（JSONL + SHA256 校验）
 * 5. 每迭代后追加 notes.md 段落（跨轮记忆）
 * 6. 终止条件判定：
 *    - plan 返回 taskCard=null → finalStatus="completed"（全部任务完成）
 *    - verify 通过 + stopWhen 命中 → finalStatus="stop_when"
 *    - 连续失败 >= abort 阈值 → finalStatus="aborted"
 *    - 迭代次数达到上限 → finalStatus="failed"
 * 7. 累计统计：totalIterations / totalLlmCallCount / totalTokensUsed / durationSec
 * 8. 累计触发护栏记录（triggeredGuards）供审计
 * 9. 返回 AutonomousRunResult（不可变，Object.freeze 冻结）
 *
 * 关键技术决策：
 * - 最大迭代次数默认 10（用户任务说明显式要求，区别于架构 §4.1 的 50）
 * - 连续失败 abort 阈值默认 3（对齐架构 §4.4 AutonomousConfig.consecutiveFailureAbort）
 * - 测试命令默认 "npm test"（对齐 verify-stage-handler 默认值）
 * - 测试超时默认 600 秒（对齐架构 §4.4 testTimeoutSec）
 * - 4 阶段全部 success 时重置 consecutiveFailures=0（对齐 RalphLoopController 行为）
 * - 任一阶段 fatal → 立即中止循环，finalStatus 由该阶段决定
 * - 任一阶段 failed → 累加 consecutiveFailures，若超过阈值则 abort
 * - 不可变优先：所有接口字段 readonly + ReadonlyArray + Object.freeze
 *
 * 与架构 §4.1 Phase 5.3 完整版的差异：
 * - Phase 5.2 版（本模块）：无 RalphLoopControllerFactory / AdmissionController / SleepGuard / GitDriver
 * - Phase 5.3 完整版：注入 RalphLoopController + 6 层准入 + SleepGuard + GitDriver
 * - Phase 5.2 版通过 P5LoopExecutor 直接调度 4 个 StageHandler，简化但不破坏协议
 * - 接口签名（run/stop/status）保持前向兼容，Phase 5.3 可无缝替换本实现
 *
 * 不可变优先原则（对齐 §5.12.4 G-A6d 配置冻结）：
 * - 所有接口字段使用 readonly 修饰
 * - 数组使用 ReadonlyArray<T>
 * - 顶层配置常量使用 Object.freeze 冻结
 * - 工厂函数返回冻结对象
 *
 * @module eag/p5/autonomous-orchestrator
 */

import * as path from "node:path";
import * as fs from "node:fs";
import { execFileSync } from "node:child_process";

import type { BlockerGuardChain } from "./guards/blocker-guard-chain";
import type { GuardRecord } from "./guards/types";
import type { TaskCard } from "./guards/types";
import type { P5RunStateStore, P5RunState, P5LoopType, P5RunStateStatus } from "./run-state-store";
import type { P5NotesMemory } from "./notes-memory";
import type { P5SmartConfirmation } from "./smart-confirmation";
import type { P5LoopExecutor } from "./loop-executor";
import type { P5StageContext, P5StageResult, P5StageKind } from "./handlers/types";
import { P5_STAGE_ORDER } from "./run-state-store";

// ============================================================================
// 1. 常量定义（不可变，Object.freeze 冻结）
// ============================================================================

/**
 * 默认最大迭代次数
 *
 * 用户任务说明显式要求默认 10 次（区别于架构 §4.1 的 50）。
 * 取值 10：覆盖大多数中小型任务的 4 阶段循环需求，避免无限循环。
 *
 * 使用 Object.freeze 冻结，防止运行期被 LLM 自改（G-A6d）。
 */
const DEFAULT_MAX_ITERATIONS = 10 as const;

/**
 * 默认最大 Token 预算
 *
 * 对齐架构 §4.4 AutonomousConfig.maxTokens 默认值。
 * 取值 200000：覆盖大多数 LLM 调用场景的 token 上限。
 */
const DEFAULT_MAX_TOKENS = 200_000 as const;

/**
 * 默认连续失败 abort 阈值
 *
 * 对齐架构 §4.4 AutonomousConfig.consecutiveFailureAbort 默认值。
 * 取值 3：连续 3 次 4 阶段循环失败即触发 abort，避免无意义重试。
 */
const DEFAULT_CONSECUTIVE_FAILURE_ABORT = 3 as const;

/**
 * 默认测试命令
 *
 * 对齐 verify-stage-handler.ts 的默认值（ctx.testCommand 为空时使用 "npm test"）。
 */
const DEFAULT_TEST_COMMAND = "npm test" as const;

/**
 * 默认测试超时（秒）
 *
 * 对齐架构 §4.4 AutonomousConfig.testTimeoutSec 默认值。
 * 取值 600 秒：覆盖大多数测试套件的执行时间。
 */
const DEFAULT_TEST_TIMEOUT_SEC = 600 as const;

/**
 * 默认 stop_when 确定性停止条件
 *
 * 空字符串表示不设置 stop_when 条件（仅靠 plan 返回 taskCard=null 判定完成）。
 */
const DEFAULT_STOP_WHEN = "" as const;

/**
 * 默认 Loop 类型
 *
 * Phase 5.2 默认聚焦 coding Loop（与 verify-stage-handler 的 testCommand 默认值对齐）。
 */
const DEFAULT_INITIAL_LOOP: P5LoopType = "coding" as const;

/**
 * 默认 tasks.md 文件名（相对 projectRoot/.eag/p5/）
 */
const DEFAULT_TASKS_FILENAME = "tasks.md" as const;

/**
 * 默认 tasks.md 目录（相对 projectRoot）
 */
const DEFAULT_TASKS_DIR = ".eag/p5" as const;

/**
 * abort 标志文件目录（相对 projectRoot，存放在 .eag/p5/abort-flags/）
 *
 * 用于跨 session/跨进程中止 run() 循环：
 * - stop(runId) 创建 <projectRoot>/.eag/p5/abort-flags/<runId>.abort 文件
 * - run() 每次迭代开始时检查该文件是否存在，存在则中止循环
 * - run() 退出时在 finally 块中清理该文件
 */
const ABORT_FLAGS_DIR = ".eag/p5/abort-flags" as const;

/**
 * abort 标志文件扩展名
 *
 * 使用 .abort 后缀，避免与其他文件类型混淆。
 */
const ABORT_FILE_EXTENSION = ".abort" as const;

// ============================================================================
// 2. 类型定义（不可变优先，所有字段 readonly）
// ============================================================================

/**
 * 无人值守运行请求
 *
 * 对应架构师审查 §4.1 AutonomousRunRequest 接口契约。
 * 字段全部 readonly——请求一经构造即不可变。
 *
 * 范例：
 * ```typescript
 * const request: AutonomousRunRequest = {
 *   projectRoot: "/path/to/project",
 *   objective: "为订单服务加退款功能",
 *   maxIterations: 10,
 *   testCommand: "npm test",
 * };
 * ```
 */
export interface AutonomousRunRequest {
  /** 项目根目录（绝对或相对路径，内部 path.resolve 处理） */
  readonly projectRoot: string;
  /** 用户目标文本（如"为订单服务加退款功能并准备上线"） */
  readonly objective: string;
  /** 最大迭代次数（默认 10，上限 1000） */
  readonly maxIterations?: number;
  /** 最大 Token 预算（默认 200000） */
  readonly maxTokens?: number;
  /** stop_when 确定性停止条件（如"all tests pass"） */
  readonly stopWhen?: string;
  /** 测试命令（如"npm test"，默认 "npm test"） */
  readonly testCommand?: string;
  /** 测试超时（秒，默认 600） */
  readonly testTimeoutSec?: number;
  /** run-id（可选，未提供时由 RunStateStore 生成 12 位 UUID 前缀） */
  readonly runId?: string;
  /** 初始 Loop 类型（默认 "coding"） */
  readonly initialLoop?: P5LoopType;
  /** tasks.md 文件路径（可选，默认 <projectRoot>/.eag/p5/tasks.md） */
  readonly tasksFilePath?: string;
  /** 连续失败 abort 阈值（默认 3） */
  readonly consecutiveFailureAbort?: number;
}

/**
 * 无人值守运行结果
 *
 * 对应架构师审查 §4.1 AutonomousRunResult 接口契约。
 * 字段全部 readonly——结果一经产出即不可变。
 *
 * 退出码语义（对齐架构 §4.1）：
 * - 0：全绿（finalStatus="completed" 或 "stop_when"）
 * - 1：部分失败（finalStatus="failed"，迭代次数用尽）
 * - 2：连续失败 abort（finalStatus="aborted"）
 * - 3：stop_when 命中（与 0 区分用于监控告警）
 *
 * 注：架构 §4.1 将 exitCode=3 用于 "stop_when 命中"，
 *     但 finalStatus="completed" 与 "stop_when" 都属于正常完成，
 *     此处遵循架构语义：completed → exitCode=0，stop_when → exitCode=3。
 */
export interface AutonomousRunResult {
  /** run-id */
  readonly runId: string;
  /** 最终状态 */
  readonly finalStatus: "completed" | "failed" | "aborted" | "stop_when";
  /** 退出码（0=全绿 / 1=部分失败 / 2=连续失败 abort / 3=stop_when 命中） */
  readonly exitCode: 0 | 1 | 2 | 3;
  /** 已完成的 Loop 列表（按完成顺序） */
  readonly completedLoops: ReadonlyArray<P5LoopType>;
  /** 里程碑列表（每轮 4 阶段全绿 = 一个里程碑） */
  readonly milestones: ReadonlyArray<Readonly<P5MilestoneRecord>>;
  /** 累计迭代次数（实际执行的 4 阶段循环轮数） */
  readonly totalIterations: number;
  /** 累计 LLM 调用次数（4 阶段循环全流程汇总） */
  readonly totalLlmCallCount: number;
  /** 累计 Token 消耗（input + output） */
  readonly totalTokensUsed: number;
  /** 总耗时（秒） */
  readonly durationSec: number;
  /** 最终报告（Markdown 格式，人类可读） */
  readonly finalReport: string;
  /** 阻塞分析报告（finalStatus != completed/stop_when 时填写） */
  readonly blockageReport?: Readonly<P5BlockageReport>;
  /** 触发的护栏记录列表（含 BLOCKER 与 MAJOR，用于审计） */
  readonly triggeredGuards: ReadonlyArray<GuardRecord>;
}

/**
 * P5 里程碑记录（简化版，对齐 long-horizon MilestoneRecord 但去掉 git 相关字段）
 *
 * Phase 5.2 不集成 GitDriver，故无 commitSha / tagName 字段。
 * Phase 5.3 完整版可替换为 long-horizon MilestoneRecord。
 *
 * 字段全部 readonly——记录一经产出即不可变。
 */
export interface P5MilestoneRecord {
  /** 里程碑序号（从 1 开始计数，m1, m2, m3...） */
  readonly index: number;
  /** 里程碑名称（如 "Iter 0 完成（4 阶段全绿）"） */
  readonly name: string;
  /** 完成的 Loop 类型 */
  readonly loopType: P5LoopType;
  /** 完成时间（ISO 8601 字符串） */
  readonly completedAt: string;
  /** 关联的迭代号（0-based） */
  readonly iterIndex: number;
  /** 该里程碑的摘要（如"3 个测试通过，0 个失败"） */
  readonly summary: string;
}

/**
 * P5 阻塞分析报告（简化版）
 *
 * Phase 5.2 不集成 BlockageAnalyzer，仅记录根因假设与建议方案。
 * Phase 5.3 完整版可替换为 long-horizon BlockageReport。
 *
 * 字段全部 readonly——报告一经产出即不可变。
 */
export interface P5BlockageReport {
  /** run-id */
  readonly runId: string;
  /** 生成时间（ISO 8601 字符串） */
  readonly generatedAt: string;
  /** 阻塞的 Loop 类型 */
  readonly blockedLoop: P5LoopType;
  /** 阻塞的迭代号 */
  readonly blockedIteration: number;
  /** 阻塞的最后一个阶段 */
  readonly blockedStage: P5StageKind;
  /** 根因假设列表（基于失败模式分析） */
  readonly rootCauseHypotheses: ReadonlyArray<string>;
  /** 建议方案列表（基于失败模式推荐） */
  readonly suggestedSolutions: ReadonlyArray<string>;
  /** 阻塞原因摘要 */
  readonly summary: string;
}

/**
 * 状态查询结果（TASK-P5-3.1-005 验收标准 3）
 *
 * 由 AutonomousOrchestrator.status() 返回，包含从 RunStateStore 加载的最新状态快照
 * 和格式化的 Markdown 进度报告。
 *
 * 注意：P5RunState 不含 milestones 字段（milestones 是 run() 内部局部变量），
 * 因此 AutonomousStatusResult 也不返回 milestones。如需查询里程碑，
 * 请在 run() 完成后从 AutonomousRunResult.milestones 获取。
 *
 * 字段全部 readonly——结果一经产出即不可变。
 */
export interface AutonomousStatusResult {
  /** run-id */
  readonly runId: string;
  /** 当前状态（running / paused / completed / failed / aborted） */
  readonly status: P5RunState["status"];
  /** 已完成迭代数 */
  readonly iterIndex: number;
  /** 当前阶段（plan / dev / verify / fix） */
  readonly currentStage: P5RunState["currentStage"];
  /** 已完成的 Loop 列表 */
  readonly completedLoops: ReadonlyArray<P5LoopType>;
  /** 累计 Token 消耗 */
  readonly totalTokensUsed: number;
  /** 累计 LLM 调用次数 */
  readonly totalLlmCallCount: number;
  /** 连续失败次数 */
  readonly consecutiveFailures: number;
  /** 最大迭代次数 */
  readonly maxIterations: number;
  /** stop_when 条件（如已设置） */
  readonly stopWhen: string;
  /** 启动时间（ISO 8601） */
  readonly startedAt: string;
  /** 最近更新时间（ISO 8601） */
  readonly updatedAt: string;
  /** Markdown 格式的进度报告 */
  readonly report: string;
  /** 是否找到了该 runId 的状态文件 */
  readonly found: boolean;
}

/**
 * 中止/回滚结果（TASK-P5-3.1-006 验收标准 1）
 *
 * 由 AutonomousOrchestrator.stop() 返回，根据运行状态返回不同信息：
 * - status="running"/"paused"：创建 abort 标志文件，action="abort"
 * - status="completed"/"failed"/"aborted"：返回回滚信息，action="rollback"
 *
 * Phase 5.2 版的回滚信息（不返回 git tag，仅返回 HEAD SHA + 未提交清单）：
 * - headSha：当前 HEAD SHA（通过 git rev-parse HEAD 获取）
 * - uncommittedFiles：未提交改动文件清单（通过 git status --porcelain 获取）
 * - 由用户手动执行 git reset --hard <sha> 完成回滚
 *
 * 字段全部 readonly——结果一经产出即不可变。
 */
export interface AutonomousStopResult {
  /** run-id */
  readonly runId: string;
  /** 操作类型：abort（中止正在运行）/ rollback（回滚已完成）/ not-found（runId 不存在） */
  readonly action: "abort" | "rollback" | "not-found";
  /** 操作是否成功 */
  readonly success: boolean;
  /** stop 操作时的 RunState 状态快照 */
  readonly runStatus: P5RunState["status"];
  /** 当前 HEAD SHA（action="rollback" 时填写，用户据此手动 git reset） */
  readonly headSha?: string;
  /** 未提交改动文件清单（action="rollback" 时填写） */
  readonly uncommittedFiles?: ReadonlyArray<string>;
  /** Markdown 格式的操作报告 */
  readonly report: string;
}

/**
 * AutonomousOrchestrator 构造选项
 *
 * 注入式依赖：调用方必须提供全部 5 个核心依赖，
 * 确保 Orchestrator 自身不耦合具体实现（便于测试与替换）。
 *
 * 字段全部 readonly——一经构造即不可变。
 */
export interface AutonomousOrchestratorOptions {
  /** 4 阶段循环分流器（必须） */
  readonly loopExecutor: P5LoopExecutor;
  /** RunState 持久化存储（必须） */
  readonly runStateStore: P5RunStateStore;
  /** 跨轮 notes.md 记忆（必须） */
  readonly notesMemory: P5NotesMemory;
  /** 6 层 15 条 BLOCKER 护栏守护链（必须） */
  readonly guardChain: BlockerGuardChain;
  /** 命令级三态确认器（必须） */
  readonly smartConfirmation: P5SmartConfirmation;
  /** 默认最大迭代次数（默认 10） */
  readonly defaultMaxIterations?: number;
  /** 默认最大 Token 预算（默认 200000） */
  readonly defaultMaxTokens?: number;
  /** 默认连续失败 abort 阈值（默认 3） */
  readonly defaultConsecutiveFailureAbort?: number;
  /** 默认测试命令（默认 "npm test"） */
  readonly defaultTestCommand?: string;
  /** 默认测试超时秒数（默认 600） */
  readonly defaultTestTimeoutSec?: number;
  /** 日志回调（可选） */
  readonly logger?: AutonomousOrchestratorLogCallback;
}

/**
 * 日志回调函数类型
 *
 * 复用 P5LogCallback 签名（message + level），独立命名避免循环依赖。
 */
export type AutonomousOrchestratorLogCallback = (message: string, level?: "info" | "warn" | "error") => void;

// ============================================================================
// 3. 默认日志空函数
// ============================================================================

/**
 * 默认日志空函数（避免 undefined 判空）
 *
 * 对齐 run-state-store / notes-memory / loop-executor 的 noopLog 模式。
 */
function autonomousNoopLog(_message: string, _level?: "info" | "warn" | "error"): void {
  // 默认无操作
}

// ============================================================================
// 4. AutonomousOrchestrator 主类
// ============================================================================

/**
 * AutonomousOrchestrator —— EAG-P5 Phase 5.2 无人值守编排器
 *
 * 设计原则（对齐 Karpathy Goal-Driven Execution + Ponytail 红线）：
 *   1. 单一职责：仅做"4 阶段循环调度 + 终止条件判定 + 状态持久化"
 *   2. 真实实现：直接调用 LoopExecutor.execute() + RunStateStore.save()，不模拟
 *   3. 不可变优先：所有字段 readonly + Object.freeze
 *   4. 异常隔离：handler 异常由 LoopExecutor 兜底，Orchestrator 仅处理 StageResult
 *
 * 使用方式：
 * ```typescript
 * const orchestrator = new AutonomousOrchestrator({
 *   loopExecutor: createP5LoopExecutor({ handlers: { ... } }),
 *   runStateStore: new P5RunStateStore(),
 *   notesMemory: new P5NotesMemory(),
 *   guardChain: createDefaultBlockerGuardChain(),
 *   smartConfirmation: new P5SmartConfirmation(),
 * });
 * const result = await orchestrator.run({
 *   projectRoot: "/path/to/project",
 *   objective: "为订单服务加退款功能",
 *   maxIterations: 10,
 *   testCommand: "npm test",
 * });
 * console.log(result.finalStatus, result.exitCode);
 * ```
 */
export class AutonomousOrchestrator {
  /** 4 阶段循环分流器 */
  private readonly loopExecutor: P5LoopExecutor;
  /** RunState 持久化存储 */
  private readonly runStateStore: P5RunStateStore;
  /** 跨轮 notes.md 记忆 */
  private readonly notesMemory: P5NotesMemory;
  /** 6 层 15 条 BLOCKER 护栏守护链 */
  private readonly guardChain: BlockerGuardChain;
  /** 命令级三态确认器 */
  private readonly smartConfirmation: P5SmartConfirmation;
  /** 默认最大迭代次数 */
  private readonly defaultMaxIterations: number;
  /** 默认最大 Token 预算 */
  private readonly defaultMaxTokens: number;
  /** 默认连续失败 abort 阈值 */
  private readonly defaultConsecutiveFailureAbort: number;
  /** 默认测试命令 */
  private readonly defaultTestCommand: string;
  /** 默认测试超时秒数 */
  private readonly defaultTestTimeoutSec: number;
  /** 日志回调 */
  private readonly log: AutonomousOrchestratorLogCallback;

  /**
   * @param options 构造选项（含 5 个核心依赖 + 默认配置 + 可选 logger）
   * @throws Error 核心依赖缺失时抛出（fail-closed）
   */
  constructor(options: Readonly<AutonomousOrchestratorOptions>) {
    // 1. 校验入参
    if (!options || typeof options !== "object") {
      throw new Error("AutonomousOrchestrator 构造失败：options 必须为对象");
    }

    // 2. 校验核心依赖（5 个必填）
    if (!options.loopExecutor) {
      throw new Error("AutonomousOrchestrator 构造失败：loopExecutor 必填");
    }
    if (!options.runStateStore) {
      throw new Error("AutonomousOrchestrator 构造失败：runStateStore 必填");
    }
    if (!options.notesMemory) {
      throw new Error("AutonomousOrchestrator 构造失败：notesMemory 必填");
    }
    if (!options.guardChain) {
      throw new Error("AutonomousOrchestrator 构造失败：guardChain 必填");
    }
    if (!options.smartConfirmation) {
      throw new Error("AutonomousOrchestrator 构造失败：smartConfirmation 必填");
    }

    // 3. 注入依赖
    this.loopExecutor = options.loopExecutor;
    this.runStateStore = options.runStateStore;
    this.notesMemory = options.notesMemory;
    this.guardChain = options.guardChain;
    this.smartConfirmation = options.smartConfirmation;

    // 4. 解析默认配置（应用默认值）
    this.defaultMaxIterations = options.defaultMaxIterations ?? DEFAULT_MAX_ITERATIONS;
    this.defaultMaxTokens = options.defaultMaxTokens ?? DEFAULT_MAX_TOKENS;
    this.defaultConsecutiveFailureAbort = options.defaultConsecutiveFailureAbort ?? DEFAULT_CONSECUTIVE_FAILURE_ABORT;
    this.defaultTestCommand = options.defaultTestCommand ?? DEFAULT_TEST_COMMAND;
    this.defaultTestTimeoutSec = options.defaultTestTimeoutSec ?? DEFAULT_TEST_TIMEOUT_SEC;
    this.log = options.logger ?? autonomousNoopLog;
  }

  // ------------------------------------------------------------------------
  // 公共 API
  // ------------------------------------------------------------------------

  /**
   * 启动无人值守运行
   *
   * 完整时序（对齐架构 §4.1 + 用户任务说明）：
   * 1. 校验 request（projectRoot / objective 必填）
   * 2. 解析默认配置（maxIterations / maxTokens / testCommand / 等）
   * 3. 调用 runStateStore.initialize() 创建 RunState（status="running"）
   * 4. 进入主循环：while iterIndex < maxIterations && status === "running"
   *    a. 加载 notesSnapshot（notesMemory.loadNotes）
   *    b. 顺序执行 4 阶段：plan → dev → verify → fix
   *       - 每阶段构造 P5StageContext（含 prevResults）
   *       - 调用 loopExecutor.execute(stage, ctx)
   *       - 累加 guardRecords / tokensUsed / llmCallCount
   *       - fatal → 立即中止内层循环
   *       - failed → 累加 consecutiveFailures
   *    c. 4 阶段全 success → 重置 consecutiveFailures，记录 milestone
   *    d. plan 返回 taskCard=null → finalStatus="completed"，中止外层循环
   *    e. verify 通过 + stopWhen 命中 → finalStatus="stop_when"，中止外层循环
   *    f. consecutiveFailures >= abort 阈值 → finalStatus="aborted"，中止外层循环
   *    g. 保存 RunState 快照（runStateStore.save）
   *    h. 追加 notes 段落（notesMemory.appendNote）
   *    i. iterIndex++
   * 5. 构造 AutonomousRunResult（含 milestones / guardRecords / finalReport）
   * 6. 返回结果（冻结对象）
   *
   * @param request 运行请求
   * @returns 运行结果（Promise，冻结对象）
   */
  async run(request: Readonly<AutonomousRunRequest>): Promise<Readonly<AutonomousRunResult>> {
    const startTime = Date.now();

    // 1. 校验 request
    this.validateRequest(request);

    // 2. 解析配置（应用默认值）
    const projectRoot = path.resolve(request.projectRoot);
    const objective = request.objective;
    const maxIterations = this.resolveMaxIterations(request.maxIterations);
    const maxTokens = request.maxTokens ?? this.defaultMaxTokens;
    const stopWhen = request.stopWhen ?? DEFAULT_STOP_WHEN;
    const testCommand = request.testCommand ?? this.defaultTestCommand;
    const testTimeoutSec = request.testTimeoutSec ?? this.defaultTestTimeoutSec;
    const initialLoop: P5LoopType = request.initialLoop ?? DEFAULT_INITIAL_LOOP;
    const consecutiveFailureAbort = request.consecutiveFailureAbort ?? this.defaultConsecutiveFailureAbort;
    const tasksFilePath = this.resolveTasksFilePath(request.tasksFilePath, projectRoot);

    this.log(
      `AutonomousOrchestrator.run 启动：projectRoot=${projectRoot} objective="${objective}" maxIterations=${maxIterations}`,
      "info"
    );

    // 3. 初始化累计统计变量（在 try 块之前声明，确保 finally 块可访问 runId 用于清理）
    let currentRunState: Readonly<P5RunState> | null = null;
    let runId = request.runId ?? "";
    let consecutiveFailures = 0;
    let totalLlmCallCount = 0;
    let totalTokensUsed = 0;
    let iterIndex = 0;
    // iterationsExecuted 记录实际执行的迭代次数（无论 status 是否变化都递增）
    // 与 iterIndex 区别：iterIndex 在 status 变化时不递增（用于 RunState 恢复定位），
    // iterationsExecuted 始终递增（用于结果统计 totalIterations）
    let iterationsExecuted = 0;
    let status: "running" | "completed" | "failed" | "aborted" | "stop_when" = "running";
    let finalStatus: "completed" | "failed" | "aborted" | "stop_when" = "failed";
    let lastFatalStage: P5StageKind | null = null;
    let lastFatalReason = "";
    const milestones: P5MilestoneRecord[] = [];
    const triggeredGuards: GuardRecord[] = [];
    const completedLoops: P5LoopType[] = [];

    // 5. 主循环（包装在 try/finally 中，finally 块清理 abort 标志文件）
    // 设计理由：无论 run() 以何种方式退出（成功/失败/中止/异常），都需清理 abort 标志文件，
    // 避免遗留文件影响后续运行（虽然 runId 是 UUID 前缀，理论不会重复）
    // 注：initialize() 也移入 try 块内，确保即使 initialize 失败，finally 块也能
    //     清理可能存在的 abort 文件（如用户预先创建的 abort 文件）
    let result: AutonomousRunResult;
    try {
      // 3a. 初始化 RunState 持久化存储（移入 try 块，确保 finally 覆盖）
      const initialState = await this.runStateStore.initialize({
        projectRoot,
        objective,
        runId: request.runId,
        initialLoop,
        maxIterations,
        maxTokens,
        stopWhen,
      });

      currentRunState = initialState;
      runId = initialState.runId;
      this.log(`AutonomousOrchestrator.run 已初始化 RunState：runId=${runId}`, "info");

      // 类型守卫：确保 currentRunState 非空（后续 while 循环内安全使用）
      // 此处 currentRunState 已通过 L603 赋值，理论上不可能为 null
      if (currentRunState === null) {
        throw new Error("AutonomousOrchestrator.run 内部错误：initialize 后 currentRunState 仍为 null");
      }

      while (iterIndex < maxIterations && status === "running") {
        // 新增：检查 abort 标志文件（循环顶部，进入迭代逻辑之前）
        // 使用已 resolve 的 projectRoot 局部变量（L550），而非 request.projectRoot
        // 否则相对路径会导致 stop() 创建的 abort 文件（绝对路径）与 run() 检测的路径不一致
        const abortFilePath = path.join(projectRoot, ABORT_FLAGS_DIR, `${runId}${ABORT_FILE_EXTENSION}`);
        if (fs.existsSync(abortFilePath)) {
          this.log(`检测到 abort 标志文件，中止运行: ${runId}`, "warn");
          status = "aborted";
          finalStatus = "aborted";
          // P1-1 修复：break 之前持久化 status="aborted" 到 RunState
          // 否则 status/stop 查询会读到过期的 "running" 状态，导致：
          // 1. /eag-autonomous-status 返回错误的 running 状态
          // 2. /eag-autonomous-stop 读到 running 走 abort 分支，创建孤儿 abort 文件
          if (currentRunState !== null) {
            const abortedState = await this.safeSaveRunState(currentRunState, {
              iterIndex,
              currentStage: this.getLastExecutedStage([]) ?? "plan",
              completedStages: [],
              completedLoops: Object.freeze([...completedLoops]),
              totalLlmCallCount,
              totalTokensUsed,
              consecutiveFailures,
              lastGuardTriggered:
                triggeredGuards.length > 0 ? triggeredGuards[triggeredGuards.length - 1]!.ruleId : null,
              status: "aborted" as P5RunStateStatus,
            });
            if (abortedState !== null) {
              currentRunState = abortedState;
            }
          }
          break;
        }

        this.log(`AutonomousOrchestrator.run 进入迭代 ${iterIndex}/${maxIterations}（runId=${runId}）`, "info");

        // 5a. 加载 notesSnapshot（跨轮记忆）
        const notesSnapshot = await this.safeLoadNotes(runId, projectRoot);

        // 5b. 顺序执行 4 阶段
        const iterationResults: P5StageResult[] = [];
        let iterationFailed = false;
        let iterationFatal = false;
        let planTaskCard: TaskCard | null = null;

        for (const stage of P5_STAGE_ORDER) {
          // 5b-1. 构造 P5StageContext
          const ctx = this.buildStageContext({
            runId,
            iterIndex,
            stage,
            projectRoot,
            worktreePath: projectRoot,
            objective,
            currentPlan: this.extractCurrentPlan(iterationResults, planTaskCard),
            notesSnapshot,
            prevResults: Object.freeze([...iterationResults]),
            runState: currentRunState,
            tasksFilePath,
            testCommand,
            testTimeoutSec,
            loopType: initialLoop,
          });

          // 5b-2. 调用 loopExecutor.execute(stage, ctx)
          const result = await this.loopExecutor.execute(stage, ctx);
          iterationResults.push(result as P5StageResult);

          // 5b-3. 累加统计（guardRecords / tokensUsed / llmCallCount）
          for (const gr of result.guardRecords) {
            triggeredGuards.push(gr);
          }
          totalTokensUsed += result.tokensUsed;
          // llmCallCount 近似估算：tokensUsed > 0 表示发生了 LLM 调用
          if (result.tokensUsed > 0) {
            totalLlmCallCount += 1;
          }

          // 5b-4. 提取 plan 阶段产出的任务卡
          if (stage === "plan" && result.kind === "success") {
            planTaskCard = (result.artifacts["taskCard"] as TaskCard | null) ?? null;
          }

          // 5b-5. fatal → 立即中止内层循环
          if (result.kind === "fatal") {
            iterationFatal = true;
            lastFatalStage = stage;
            lastFatalReason = result.error ?? result.summary;
            this.log(`AutonomousOrchestrator.run 迭代 ${iterIndex} 阶段 ${stage} fatal：${lastFatalReason}`, "error");
            break;
          }

          // 5b-6. failed/retriable → 累加 consecutiveFailures，但继续下一阶段
          //       （允许 fix 阶段尝试修复 verify 的失败）
          if (result.kind === "failed" || result.kind === "retriable") {
            iterationFailed = true;
            this.log(
              `AutonomousOrchestrator.run 迭代 ${iterIndex} 阶段 ${stage} ${result.kind}：${result.summary}`,
              "warn"
            );
            // 不 break：让 fix 阶段有机会修复 verify 的失败
          }
        }

        // 5c. 4 阶段全 success → 重置 consecutiveFailures，记录 milestone
        if (!iterationFatal && !iterationFailed) {
          consecutiveFailures = 0;

          // 记录里程碑
          const milestone: P5MilestoneRecord = Object.freeze({
            index: milestones.length + 1,
            name: `Iter ${iterIndex} 完成（4 阶段全绿）`,
            loopType: initialLoop,
            completedAt: new Date().toISOString(),
            iterIndex,
            summary: this.formatIterationSummary(iterationResults, true),
          });
          milestones.push(milestone);

          // 若 initialLoop 尚未在 completedLoops 中，加入
          if (!completedLoops.includes(initialLoop)) {
            completedLoops.push(initialLoop);
          }

          this.log(`AutonomousOrchestrator.run 迭代 ${iterIndex} 全绿，记录 milestone #${milestone.index}`, "info");
        } else if (iterationFatal) {
          // fatal → 累加 consecutiveFailures
          consecutiveFailures += 1;
        } else if (iterationFailed) {
          // failed → 累加 consecutiveFailures
          consecutiveFailures += 1;
        }

        // 5d. plan 返回 taskCard=null → finalStatus="completed"，中止外层循环
        if (!iterationFatal && planTaskCard === null) {
          // 注：只有当 plan 阶段 success 且 taskCard=null 才视为"全部任务完成"
          const planResult = iterationResults.find((r) => r.stage === "plan");
          if (planResult && planResult.kind === "success") {
            status = "completed";
            finalStatus = "completed";
            this.log(
              `AutonomousOrchestrator.run 迭代 ${iterIndex} 检测到 plan 返回 taskCard=null，全部任务完成`,
              "info"
            );
          }
        }

        // 5e. verify 通过 + stopWhen 命中 → finalStatus="stop_when"，中止外层循环
        if (status === "running" && !iterationFatal && !iterationFailed) {
          if (this.checkStopWhenHit(stopWhen, iterationResults)) {
            status = "stop_when";
            finalStatus = "stop_when";
            this.log(`AutonomousOrchestrator.run 迭代 ${iterIndex} 命中 stop_when 条件：${stopWhen}`, "info");
          }
        }

        // 5f. consecutiveFailures >= abort 阈值 → finalStatus="aborted"
        if (status === "running" && consecutiveFailures >= consecutiveFailureAbort) {
          status = "aborted";
          finalStatus = "aborted";
          this.log(
            `AutonomousOrchestrator.run 迭代 ${iterIndex} 连续失败 ${consecutiveFailures} 次达到阈值 ${consecutiveFailureAbort}，触发 abort`,
            "error"
          );
        }

        // 5g. 保存 RunState 快照（每次迭代后）
        const nextIterIndex = status === "running" ? iterIndex + 1 : iterIndex;
        const nextStage: "plan" | "dev" | "verify" | "fix" =
          status === "running" ? "plan" : (this.getLastExecutedStage(iterationResults) ?? "plan");
        const updatedRunState = await this.safeSaveRunState(currentRunState, {
          iterIndex: nextIterIndex,
          currentStage: nextStage,
          completedStages: this.computeCompletedStages(iterationResults, status),
          completedLoops: Object.freeze([...completedLoops]),
          totalLlmCallCount,
          totalTokensUsed,
          consecutiveFailures,
          lastGuardTriggered: triggeredGuards.length > 0 ? triggeredGuards[triggeredGuards.length - 1]!.ruleId : null,
          status: status === "running" ? "running" : this.mapToRunStateStatus(status),
        });
        if (updatedRunState !== null) {
          currentRunState = updatedRunState;
        }

        // 5h. 追加 notes 段落（每次迭代后）
        await this.safeAppendNotes(runId, projectRoot, {
          iterIndex,
          iterationResults,
          iterationFatal,
          iterationFailed,
          status,
          finalStatus,
        });

        // 5i. iterIndex++（用于 RunState 恢复定位）
        //     iterationsExecuted++（用于结果统计，无论 status 是否变化都递增）
        iterIndex = nextIterIndex;
        iterationsExecuted += 1;
      }

      // 6. 迭代次数用尽 → finalStatus="failed"
      if (status === "running") {
        status = "failed";
        finalStatus = "failed";
        this.log(`AutonomousOrchestrator.run 迭代次数用尽（${maxIterations}），finalStatus=failed`, "warn");
        // P1-1 修复：迭代用尽时持久化 status="failed" 到 RunState
        // 否则 status/stop 查询会读到过期的 "running" 状态
        // 注：此时 currentRunState 已在上次迭代的 5g 步骤保存为 status="running"，
        //     需要额外保存一次 status="failed" 反映最终状态
        const failedState = await this.safeSaveRunState(currentRunState, {
          iterIndex,
          currentStage: this.getLastExecutedStage([]) ?? "plan",
          completedStages: [],
          completedLoops: Object.freeze([...completedLoops]),
          totalLlmCallCount,
          totalTokensUsed,
          consecutiveFailures,
          lastGuardTriggered: triggeredGuards.length > 0 ? triggeredGuards[triggeredGuards.length - 1]!.ruleId : null,
          status: "failed" as P5RunStateStatus,
        });
        if (failedState !== null) {
          currentRunState = failedState;
        }
      }

      // 7. 构造 AutonomousRunResult
      const durationSec = Math.floor((Date.now() - startTime) / 1000);
      const exitCode = this.computeExitCode(finalStatus);
      const finalReport = this.generateFinalReport({
        runId,
        objective,
        finalStatus,
        exitCode,
        totalIterations: iterationsExecuted,
        totalLlmCallCount,
        totalTokensUsed,
        durationSec,
        milestones,
        triggeredGuards,
        consecutiveFailures,
        maxIterations,
        lastFatalStage,
        lastFatalReason,
      });

      const blockageReport =
        finalStatus === "aborted" || finalStatus === "failed"
          ? this.generateBlockageReport({
              runId,
              iterIndex: iterationsExecuted > 0 ? iterationsExecuted - 1 : 0,
              loopType: initialLoop,
              lastFatalStage,
              lastFatalReason,
              consecutiveFailures,
              triggeredGuards,
            })
          : undefined;

      result = Object.freeze({
        runId,
        finalStatus,
        exitCode,
        completedLoops: Object.freeze([...completedLoops]),
        milestones: Object.freeze([...milestones]),
        totalIterations: iterationsExecuted,
        totalLlmCallCount,
        totalTokensUsed,
        durationSec,
        finalReport,
        blockageReport,
        triggeredGuards: Object.freeze([...triggeredGuards]),
      });

      this.log(
        `AutonomousOrchestrator.run 结束：runId=${runId} finalStatus=${finalStatus} exitCode=${exitCode} iterations=${iterationsExecuted} duration=${durationSec}s`,
        "info"
      );
    } finally {
      // 无论 run() 以何种方式退出（成功/失败/中止/异常），清理 abort 标志文件
      // 避免遗留的 abort 文件影响下次同 runId 的运行
      this.cleanupAbortFlag(runId, projectRoot);
    }

    return result;
  }

  // ------------------------------------------------------------------------
  // 公共 API：status() / stop()（TASK-P5-3.1-005 / 006）
  // ------------------------------------------------------------------------

  /**
   * 查询运行状态（TASK-P5-3.1-005 验收标准 3）
   *
   * 从 RunStateStore 加载 runId 的最新状态快照，格式化为 Markdown 进度报告。
   * 支持查询正在运行和已完成的运行。
   *
   * 注意：P5RunState 不含 milestones 字段（milestones 是 run() 内部局部变量），
   * 因此 AutonomousStatusResult 也不返回 milestones。如需查询里程碑，
   * 请在 run() 完成后从 AutonomousRunResult.milestones 获取。
   *
   * found=false 时的字段语义（P2-12）：
   * - 当 RunState 文件不存在或加载失败时，本方法返回 found=false 的结果，
   *   此时除 runId / found / report 外的其他字段（status / iterIndex / currentStage /
   *   completedLoops / totalTokensUsed / totalLlmCallCount / consecutiveFailures /
   *   maxIterations / stopWhen / startedAt / updatedAt）均为占位默认值
   *   （status="failed"、iterIndex=0、currentStage="plan"、各数值为 0、各字符串为空），
   *   不代表真实运行状态，调用方应优先判断 found 字段，仅在 found=true 时使用其他字段。
   *
   * @param runId 运行 ID（必须符合 ^[a-zA-Z0-9_-]+$ 格式，防止路径遍历攻击）
   * @param projectRoot 项目根目录（用于定位 RunStateStore）
   * @returns 状态查询结果（含 Markdown 报告，冻结对象）
   * @throws Error runId 格式非法（含路径分隔符或非允许字符）时抛出
   */
  async status(runId: string, projectRoot: string): Promise<Readonly<AutonomousStatusResult>> {
    // 1. 校验入参
    if (typeof runId !== "string" || runId.trim().length === 0) {
      throw new Error("AutonomousOrchestrator.status 失败：runId 必须为非空字符串");
    }
    if (typeof projectRoot !== "string" || projectRoot.trim().length === 0) {
      throw new Error("AutonomousOrchestrator.status 失败：projectRoot 必须为非空字符串");
    }
    // P2-2 修复：校验 runId 格式，防止路径遍历攻击
    // （runId 用于构造 .eag/p5/run-state/<runId>.jsonl 等文件路径，
    //  必须禁止含 / \ .. 等路径字符，避免逃逸出目标目录）
    this.validateRunId(runId);

    const projectRootAbs = path.resolve(projectRoot);
    this.log(`AutonomousOrchestrator.status 查询：runId=${runId} projectRoot=${projectRootAbs}`, "info");

    // 2. 尝试从 RunStateStore 加载最新状态
    let runState: P5RunState;
    try {
      runState = await this.runStateStore.load(runId, projectRootAbs);
    } catch (err) {
      // 加载失败（文件不存在 / 校验失败）：返回 found=false 的结果
      const errMsg = err instanceof Error ? err.message : String(err);
      this.log(`AutonomousOrchestrator.status 加载 RunState 失败：${errMsg}`, "warn");
      const notFoundReport = this.formatStatusNotFoundReport(runId, errMsg);
      return Object.freeze({
        runId,
        status: "failed" as P5RunState["status"],
        iterIndex: 0,
        currentStage: "plan" as P5RunState["currentStage"],
        completedLoops: Object.freeze([]),
        totalTokensUsed: 0,
        totalLlmCallCount: 0,
        consecutiveFailures: 0,
        maxIterations: 0,
        stopWhen: "",
        startedAt: "",
        updatedAt: "",
        report: notFoundReport,
        found: false,
      });
    }

    // 3. 格式化 Markdown 报告
    const report = this.formatStatusReport(runState);

    // 4. 构造并返回冻结的结果对象
    return Object.freeze({
      runId,
      status: runState.status,
      iterIndex: runState.iterIndex,
      currentStage: runState.currentStage,
      completedLoops: runState.completedLoops,
      totalTokensUsed: runState.totalTokensUsed,
      totalLlmCallCount: runState.totalLlmCallCount,
      consecutiveFailures: runState.consecutiveFailures,
      maxIterations: runState.maxIterations,
      stopWhen: runState.stopWhen,
      startedAt: runState.startedAt,
      updatedAt: runState.updatedAt,
      report,
      found: true,
    });
  }

  /**
   * 中止运行或返回回滚所需信息（TASK-P5-3.1-006 验收标准 1）
   *
   * 行为取决于运行状态：
   * - status="running"/"paused"：创建 abort 标志文件，run() 在下次迭代时检测并中止
   * - status="completed"/"failed"/"aborted"：返回回滚所需信息（HEAD SHA + 未提交清单）
   * - runId 不存在（RunState 文件加载失败）：返回 action="not-found"，success=false
   *
   * Phase 5.2 版的回滚信息：
   * - 不返回 git tag（run() 不创建 tag，P5RunState 无 commitSha 字段）
   * - 仅返回当前 HEAD SHA（通过 git rev-parse HEAD 获取）
   * - 返回未提交改动文件清单（通过 git status --porcelain 获取）
   * - 由用户手动执行 git reset --hard <sha> 完成回滚
   *
   * TOCTOU 竞态说明（P2-5）：
   * - stop() 的 load → createAbortFlag 之间存在 TOCTOU（Time-of-Check-to-Time-of-Use）竞态：
   *   若 run() 在 load 与 createAbortFlag 之间恰好完成并清理 RunState 文件，
   *   createAbortFlag 创建的 abort 文件将成为孤儿（run() 已退出不会再清理）。
   * - 缓解措施：① abort 文件以 runId 命名，理论不会重复；② 孤儿 abort 文件不影响后续不同 runId 的运行；
   *   ③ 用户可手动删除 .eag/p5/abort-flags/ 下的孤儿文件。
   * - 此竞态在 Phase 5.2 文件系统实现下无法完全消除，Phase 5.3 引入进程级锁后可解决。
   *
   * @param runId 运行 ID（必须符合 ^[a-zA-Z0-9_-]+$ 格式，防止路径遍历攻击）
   * @param projectRoot 项目根目录
   * @returns 中止/回滚结果（含 Markdown 报告，冻结对象）
   * @throws Error runId 格式非法（含路径分隔符或非允许字符）时抛出
   */
  async stop(runId: string, projectRoot: string): Promise<Readonly<AutonomousStopResult>> {
    // 1. 校验入参
    if (typeof runId !== "string" || runId.trim().length === 0) {
      throw new Error("AutonomousOrchestrator.stop 失败：runId 必须为非空字符串");
    }
    if (typeof projectRoot !== "string" || projectRoot.trim().length === 0) {
      throw new Error("AutonomousOrchestrator.stop 失败：projectRoot 必须为非空字符串");
    }
    // P2-2 修复：校验 runId 格式，防止路径遍历攻击
    // （runId 用于构造 .eag/p5/abort-flags/<runId>.abort 等文件路径，
    //  必须禁止含 / \ .. 等路径字符，避免逃逸出目标目录）
    this.validateRunId(runId);

    const projectRootAbs = path.resolve(projectRoot);
    this.log(`AutonomousOrchestrator.stop 请求：runId=${runId} projectRoot=${projectRootAbs}`, "info");

    // 2. 尝试从 RunStateStore 加载最新状态
    let runState: P5RunState;
    try {
      runState = await this.runStateStore.load(runId, projectRootAbs);
    } catch (err) {
      // 加载失败（文件不存在 / 校验失败）：返回 action="not-found" / success=false 的结果
      // P1-2 修复：action 语义从 "abort" 改为 "not-found"，避免误导调用方
      //   既有实现返回 action="abort" + success=false，调用方若仅依 action 分流，
      //   会误以为是"中止失败"而非"runId 不存在"，进而执行错误的回滚逻辑。
      //   改为 action="not-found" 后，调用方可明确区分"中止失败"与"runId 不存在"。
      const errMsg = err instanceof Error ? err.message : String(err);
      this.log(`AutonomousOrchestrator.stop 加载 RunState 失败：${errMsg}`, "warn");
      const notFoundReport = this.formatStopNotFoundReport(runId, errMsg);
      return Object.freeze({
        runId,
        action: "not-found" as const,
        success: false,
        runStatus: "failed" as P5RunState["status"],
        report: notFoundReport,
      });
    }

    // 3. 根据运行状态分流
    if (runState.status === "running" || runState.status === "paused") {
      // 3a. 正在运行或暂停：创建 abort 标志文件
      return await this.createAbortFlag(runId, projectRootAbs, runState);
    } else {
      // 3b. 已完成/失败/中止：返回回滚信息（HEAD SHA + 未提交清单）
      return await this.collectRollbackInfo(runId, projectRootAbs, runState);
    }
  }

  // ------------------------------------------------------------------------
  // 私有方法：status() 辅助方法
  // ------------------------------------------------------------------------

  /**
   * 格式化状态查询的 Markdown 报告
   *
   * @param runState 最新 RunState 快照
   * @returns Markdown 格式的状态报告
   */
  private formatStatusReport(runState: Readonly<P5RunState>): string {
    const lines: string[] = [];
    lines.push("## Autonomous Run Status");
    lines.push("");
    lines.push("| 字段 | 值 |");
    lines.push("|------|-----|");
    lines.push(`| Run ID | ${runState.runId} |`);
    lines.push(`| 状态 | ${runState.status} |`);
    lines.push(`| 当前阶段 | ${runState.currentStage} |`);
    lines.push(`| 迭代次数 | ${runState.iterIndex} / ${runState.maxIterations} |`);
    lines.push(`| 完成 Loops | ${runState.completedLoops.join(", ") || "（无）"} |`);
    lines.push(`| Token 消耗 | ${runState.totalTokensUsed} |`);
    lines.push(`| LLM 调用 | ${runState.totalLlmCallCount} |`);
    lines.push(`| 连续失败 | ${runState.consecutiveFailures} |`);
    lines.push(`| 启动时间 | ${runState.startedAt} |`);
    lines.push(`| 最近更新 | ${runState.updatedAt} |`);
    lines.push(`| stop_when | ${runState.stopWhen || "（未设置）"} |`);
    return lines.join("\n");
  }

  /**
   * 格式化状态查询"未找到"的 Markdown 报告
   *
   * @param runId 运行 ID
   * @param errMsg 错误信息
   * @returns Markdown 格式的错误报告
   */
  private formatStatusNotFoundReport(runId: string, errMsg: string): string {
    const lines: string[] = [];
    lines.push("## Autonomous Run Status");
    lines.push("");
    lines.push(`**未找到 runId=${runId} 的状态文件**`);
    lines.push("");
    lines.push(`错误详情：${errMsg}`);
    lines.push("");
    lines.push("可能原因：");
    lines.push("- runId 拼写错误");
    lines.push("- 运行尚未启动");
    lines.push("- 状态文件已被清理");
    return lines.join("\n");
  }

  // ------------------------------------------------------------------------
  // 私有方法：stop() 辅助方法
  // ------------------------------------------------------------------------

  /**
   * 创建 abort 标志文件（中止正在运行的会话）
   *
   * @param runId 运行 ID
   * @param projectRootAbs 项目根目录（绝对路径）
   * @param runState 最新 RunState 快照
   * @returns 中止结果（含 Markdown 报告，冻结对象）
   */
  private async createAbortFlag(
    runId: string,
    projectRootAbs: string,
    runState: Readonly<P5RunState>
  ): Promise<Readonly<AutonomousStopResult>> {
    try {
      // 1. 确保 abort-flags 目录存在
      const abortFlagsDir = path.join(projectRootAbs, ABORT_FLAGS_DIR);
      if (!fs.existsSync(abortFlagsDir)) {
        fs.mkdirSync(abortFlagsDir, { recursive: true });
        this.log(`已创建 abort 标志目录：${abortFlagsDir}`, "info");
      }

      // 2. 创建 abort 标志文件（空文件，仅作为存在性标志）
      const abortFilePath = path.join(abortFlagsDir, `${runId}${ABORT_FILE_EXTENSION}`);
      // 幂等性：文件已存在时不报错，覆盖写入即可
      fs.writeFileSync(abortFilePath, "", { encoding: "utf-8" });
      this.log(`已创建 abort 标志文件：${abortFilePath}`, "info");

      // 3. 构造 Markdown 报告
      const report = this.formatAbortReport(runId, runState);

      return Object.freeze({
        runId,
        action: "abort" as const,
        success: true,
        runStatus: runState.status,
        report,
      });
    } catch (err) {
      // 创建 abort 文件失败：返回 success=false 的结果
      const errMsg = err instanceof Error ? err.message : String(err);
      this.log(`创建 abort 标志文件失败：${errMsg}`, "error");
      const report = this.formatAbortFailureReport(runId, runState, errMsg);
      return Object.freeze({
        runId,
        action: "abort" as const,
        success: false,
        runStatus: runState.status,
        report,
      });
    }
  }

  /**
   * 收集回滚信息（HEAD SHA + 未提交清单）
   *
   * @param runId 运行 ID
   * @param projectRootAbs 项目根目录（绝对路径）
   * @param runState 最新 RunState 快照
   * @returns 回滚结果（含 Markdown 报告，冻结对象）
   */
  private async collectRollbackInfo(
    runId: string,
    projectRootAbs: string,
    runState: Readonly<P5RunState>
  ): Promise<Readonly<AutonomousStopResult>> {
    let headSha = "";
    let uncommittedFiles: string[] = [];
    // P2-9 修复：使用错误数组记录所有 git 命令失败信息，全部透传到 report
    // 既有实现仅记录第一次错误（if gitError === null），第二次失败被吞掉，
    // 用户在 report 中看不到第二次失败原因，无法完整排查。
    // 改为数组后，所有失败信息都会出现在 report 中，便于用户诊断。
    const gitErrors: string[] = [];

    try {
      // 1. 获取当前 HEAD SHA
      // P2-7 修复：设置 maxBuffer=10MB，避免大仓库输出溢出 execFileSync 默认 1MB 限制
      //   （git rev-parse HEAD 输出仅 40 字符，理论不会溢出，但显式设置 maxBuffer
      //    与下方 git status 保持一致，便于维护与未来扩展）
      const headShaRaw = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: projectRootAbs,
        encoding: "utf-8",
        timeout: 10_000,
        maxBuffer: 10 * 1024 * 1024,
      }).trim();
      headSha = headShaRaw;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      gitErrors.push(`git rev-parse HEAD 失败：${msg}`);
      this.log(`获取 HEAD SHA 失败：${msg}`, "warn");
    }

    try {
      // 2. 获取未提交改动文件清单
      // 注：使用 --untracked-files=all 展开未跟踪目录下的所有文件，
      //     避免默认行为将未跟踪目录折叠为 "?? src/" 而丢失具体文件路径，
      //     确保回滚清单完整（用户据此手动 git reset 后能完整评估影响范围）。
      //     使用长格式 --untracked-files=all 而非 -u all，避免 shell 参数分割歧义
      //     （-u all 在某些 shell 中会被解析为 -u + 路径参数 "all"，导致输出为空）
      // P2-7 修复：设置 maxBuffer=10MB，避免大仓库 git status 输出溢出默认 1MB 限制
      //   （大型 monorepo 的未提交清单可达数 MB，默认 maxBuffer 会抛 ERR_CHILD_PROCESS_STDIO_MAXBUFFER）
      const statusOutput = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
        cwd: projectRootAbs,
        encoding: "utf-8",
        timeout: 10_000,
        maxBuffer: 10 * 1024 * 1024,
      }).trim();
      // 解析 porcelain 输出：每行前 3 字符为状态码（2 字符状态 + 1 字符空格），后续为文件路径
      // 注意：对于含空格/特殊字符的文件名，git 会用双引号包裹并 C 转义，
      //       此处仅做 trim 去除首尾空白，不剥离引号（保持与 git 输出一致，便于用户识别）
      // P2-1 修复：正确处理 R/C 重命名格式（"R  old.js -> new.js"）
      //   git status --porcelain 对重命名/复制的输出格式为 "<XY> <old> -> <new>"，
      //   既有实现直接 slice(3).trim() 会得到 "old.js -> new.js" 整串，
      //   用户难以快速识别实际影响的文件。改为：检测 " -> " 分隔符，取分隔符后的新文件名，
      //   与 git status 默认展示行为一致（显示重命名后的目标路径）。
      if (statusOutput.length > 0) {
        uncommittedFiles = statusOutput
          .split("\n")
          .map((line) => {
            const filePathPart = line.slice(3).trim();
            // 检测重命名/复制格式："old.js -> new.js"
            // git porcelain 重命名格式：R  old.js -> new.js（R 后跟空格，再跟原文件名 -> 新文件名）
            // 使用 " -> " 作为分隔符（前后各一个空格），避免误匹配文件名中含 "->" 的边界情况
            const renameSep = " -> ";
            const renameIdx = filePathPart.indexOf(renameSep);
            if (renameIdx >= 0) {
              // 重命名/复制：取分隔符后的新文件名
              return filePathPart.slice(renameIdx + renameSep.length).trim();
            }
            // 普通改动：直接使用文件路径
            return filePathPart;
          })
          .filter((filePath) => filePath.length > 0);
      }
    } catch (err) {
      // P2-9 修复：所有 git 命令失败信息都记录到 gitErrors 数组，全部透传到 report
      const msg = err instanceof Error ? err.message : String(err);
      gitErrors.push(`git status --porcelain 失败：${msg}`);
      this.log(`获取未提交清单失败：${msg}`, "warn");
    }

    // 3. 构造 Markdown 报告（gitErrors 数组通过 formatRollbackReport 透传到 report）
    const report = this.formatRollbackReport(runId, runState, headSha, uncommittedFiles, gitErrors);

    return Object.freeze({
      runId,
      action: "rollback" as const,
      success: true,
      runStatus: runState.status,
      ...(headSha.length > 0 ? { headSha } : {}),
      ...(uncommittedFiles.length > 0 ? { uncommittedFiles: Object.freeze([...uncommittedFiles]) } : {}),
      report,
    });
  }

  /**
   * 格式化中止成功的 Markdown 报告
   *
   * @param runId 运行 ID
   * @param runState 最新 RunState 快照
   * @returns Markdown 格式的中止报告
   */
  private formatAbortReport(runId: string, runState: Readonly<P5RunState>): string {
    const lines: string[] = [];
    lines.push("## Autonomous Run Stop (Abort)");
    lines.push("");
    lines.push(`- **Run ID**：${runId}`);
    lines.push(`- **操作**：已创建 abort 标志文件`);
    lines.push(`- **当前状态**：${runState.status}`);
    lines.push(`- **当前迭代**：${runState.iterIndex} / ${runState.maxIterations}`);
    lines.push(`- **当前阶段**：${runState.currentStage}`);
    lines.push("");
    lines.push("**说明**：");
    lines.push("- abort 标志文件已创建，run() 将在下次迭代开始时检测并中止");
    lines.push("- 如果当前迭代正在执行长耗时操作（如 LLM 调用），中止可能延迟");
    lines.push("- run() 中止后会自动清理 abort 标志文件");
    return lines.join("\n");
  }

  /**
   * 格式化中止失败的 Markdown 报告
   *
   * @param runId 运行 ID
   * @param runState 最新 RunState 快照
   * @param errMsg 错误信息
   * @returns Markdown 格式的失败报告
   */
  private formatAbortFailureReport(runId: string, runState: Readonly<P5RunState>, errMsg: string): string {
    const lines: string[] = [];
    lines.push("## Autonomous Run Stop (Abort Failed)");
    lines.push("");
    lines.push(`- **Run ID**：${runId}`);
    lines.push(`- **操作**：创建 abort 标志文件失败`);
    lines.push(`- **当前状态**：${runState.status}`);
    lines.push(`- **错误信息**：${errMsg}`);
    lines.push("");
    lines.push("**建议排查方向**：");
    lines.push("- 检查 projectRoot 是否有写入权限");
    lines.push("- 检查 .eag/p5/abort-flags/ 目录是否可创建");
    return lines.join("\n");
  }

  /**
   * 格式化回滚信息的 Markdown 报告
   *
   * @param runId 运行 ID
   * @param runState 最新 RunState 快照
   * @param headSha 当前 HEAD SHA（可能为空）
   * @param uncommittedFiles 未提交改动文件清单
   * @param gitErrors git 命令错误信息数组（无错误时为空数组，P2-9 修复：透传所有失败信息）
   * @returns Markdown 格式的回滚报告
   */
  private formatRollbackReport(
    runId: string,
    runState: Readonly<P5RunState>,
    headSha: string,
    uncommittedFiles: ReadonlyArray<string>,
    gitErrors: ReadonlyArray<string>
  ): string {
    const lines: string[] = [];
    lines.push("## Autonomous Run Stop (Rollback Info)");
    lines.push("");
    lines.push(`- **Run ID**：${runId}`);
    lines.push(`- **操作**：返回回滚信息`);
    lines.push(`- **运行状态**：${runState.status}`);
    lines.push(`- **最终迭代**：${runState.iterIndex} / ${runState.maxIterations}`);
    lines.push("");

    // P2-9 修复：透传所有 git 命令失败信息（而非仅第一次）
    if (gitErrors.length > 0) {
      lines.push(`**⚠️ Git 命令执行失败**（${gitErrors.length} 个）：`);
      for (const err of gitErrors) {
        lines.push(`  - ${err}`);
      }
      lines.push("");
      lines.push("可能原因：projectRoot 不是 git 仓库，或 git 不可用，或 maxBuffer 不足");
      lines.push("");
    }

    if (headSha.length > 0) {
      lines.push(`- **当前 HEAD SHA**：\`${headSha}\``);
    } else {
      lines.push("- **当前 HEAD SHA**：（获取失败）");
    }

    if (uncommittedFiles.length > 0) {
      lines.push(`- **未提交改动文件**（${uncommittedFiles.length} 个）：`);
      for (const file of uncommittedFiles) {
        lines.push(`  - ${file}`);
      }
    } else {
      lines.push("- **未提交改动文件**：（无）");
    }

    lines.push("");
    lines.push("**手动回滚命令**（请确认后执行）：");
    if (headSha.length > 0) {
      lines.push("```bash");
      lines.push(`git reset --hard ${headSha}`);
      lines.push("```");
    } else {
      lines.push("（无法获取 HEAD SHA，请手动检查 git log 确定回滚目标）");
    }
    return lines.join("\n");
  }

  /**
   * 格式化 stop() "未找到"的 Markdown 报告
   *
   * @param runId 运行 ID
   * @param errMsg 错误信息
   * @returns Markdown 格式的错误报告
   */
  private formatStopNotFoundReport(runId: string, errMsg: string): string {
    const lines: string[] = [];
    lines.push("## Autonomous Run Stop (Not Found)");
    lines.push("");
    lines.push(`**未找到 runId=${runId} 的状态文件**`);
    lines.push("");
    lines.push(`错误详情：${errMsg}`);
    lines.push("");
    lines.push("可能原因：");
    lines.push("- runId 拼写错误");
    lines.push("- 运行尚未启动");
    lines.push("- 状态文件已被清理");
    return lines.join("\n");
  }

  /**
   * 清理 abort 标志文件（私有方法）
   *
   * 在 run() 的 finally 块中调用，确保无论 run() 以何种方式退出，
   * abort 标志文件都被清理，避免遗留文件影响后续运行。
   *
   * 容错策略：
   * - 文件不存在：静默跳过（无需日志）
   * - 删除失败：仅记录 WARN 日志，不抛异常（避免影响 run() 的正常退出）
   *
   * @param runId 运行 ID
   * @param projectRoot 项目根目录（已 resolve 的绝对路径）
   */
  private cleanupAbortFlag(runId: string, projectRoot: string): void {
    try {
      const abortFilePath = path.join(projectRoot, ABORT_FLAGS_DIR, `${runId}${ABORT_FILE_EXTENSION}`);
      if (fs.existsSync(abortFilePath)) {
        fs.unlinkSync(abortFilePath);
        this.log(`已清理 abort 标志文件: ${abortFilePath}`, "info");
      }
    } catch (err) {
      // 清理失败不影响 run() 退出，仅记录 WARN
      const msg = err instanceof Error ? err.message : String(err);
      this.log(`清理 abort 标志文件失败（不影响运行结果）: ${msg}`, "warn");
    }
  }

  // ------------------------------------------------------------------------
  // 私有方法：请求校验与配置解析
  // ------------------------------------------------------------------------

  /**
   * 校验 runId 格式（防止路径遍历攻击）
   *
   * runId 用于构造文件路径（如 abort-flags/<runId>.abort、run-state/<runId>.jsonl），
   * 必须禁止包含路径分隔符（/、\）和目录跳转符（..），防止攻击者通过 runId 逃逸出目标目录。
   *
   * 允许的字符集：字母、数字、下划线、连字符（与 RunStateStore 生成的 UUID 前缀格式一致）
   *
   * @param runId 待校验的 runId
   * @throws Error runId 含非法字符时抛出
   */
  private validateRunId(runId: string): void {
    // 校验 runId 仅含字母、数字、下划线、连字符
    // 禁止 / \ .. 等路径字符，防止路径遍历攻击
    if (!/^[a-zA-Z0-9_-]+$/.test(runId)) {
      throw new Error(`AutonomousOrchestrator runId 格式非法：${runId}（仅允许字母、数字、下划线、连字符）`);
    }
  }

  /**
   * 校验运行请求
   *
   * @param request 运行请求
   * @throws Error projectRoot/objective 缺失或非法时抛出
   */
  private validateRequest(request: Readonly<AutonomousRunRequest>): void {
    if (!request || typeof request !== "object") {
      throw new Error("AutonomousRunRequest 必须为对象");
    }
    if (typeof request.projectRoot !== "string" || request.projectRoot.trim().length === 0) {
      throw new Error("AutonomousRunRequest.projectRoot 必须为非空字符串");
    }
    if (typeof request.objective !== "string" || request.objective.trim().length === 0) {
      throw new Error("AutonomousRunRequest.objective 必须为非空字符串");
    }
    // P2-2 修复：校验 runId 格式（防止路径遍历攻击）
    if (request.runId !== undefined) {
      this.validateRunId(request.runId);
    }
  }

  /**
   * 解析最大迭代次数（应用上限校验）
   *
   * @param maxIterations 用户提供的最大迭代次数（可选）
   * @returns 校验后的最大迭代次数
   * @throws Error 超过上限 1000 时抛出
   */
  private resolveMaxIterations(maxIterations?: number): number {
    const value = maxIterations ?? this.defaultMaxIterations;
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`maxIterations 必须为正整数，实际值：${value}（默认 ${DEFAULT_MAX_ITERATIONS}）`);
    }
    if (value > 1000) {
      throw new Error(`maxIterations 上限 1000，实际值：${value}（对齐架构 §4.4 AutonomousConfig.maxIterations 上限）`);
    }
    return value;
  }

  /**
   * 解析 tasks.md 文件路径
   *
   * @param tasksFilePath 用户提供的路径（可选）
   * @param projectRoot 项目根目录
   * @returns 解析后的绝对路径
   */
  private resolveTasksFilePath(tasksFilePath: string | undefined, projectRoot: string): string {
    if (tasksFilePath && tasksFilePath.trim().length > 0) {
      return path.resolve(tasksFilePath);
    }
    return path.join(projectRoot, DEFAULT_TASKS_DIR, DEFAULT_TASKS_FILENAME);
  }

  // ------------------------------------------------------------------------
  // 私有方法：上下文构造
  // ------------------------------------------------------------------------

  /**
   * 构造 P5StageContext（不可变，Object.freeze）
   *
   * @param args 上下文构造参数
   * @returns 冻结的 P5StageContext
   */
  private buildStageContext(args: {
    readonly runId: string;
    readonly iterIndex: number;
    readonly stage: P5StageKind;
    readonly projectRoot: string;
    readonly worktreePath: string;
    readonly objective: string;
    readonly currentPlan: string;
    readonly notesSnapshot: string;
    readonly prevResults: ReadonlyArray<Readonly<P5StageResult>>;
    readonly runState: Readonly<P5RunState>;
    readonly tasksFilePath: string;
    readonly testCommand: string;
    readonly testTimeoutSec: number;
    readonly loopType: P5LoopType;
  }): Readonly<P5StageContext> {
    return Object.freeze({
      runId: args.runId,
      iterIndex: args.iterIndex,
      stage: args.stage,
      projectRoot: args.projectRoot,
      worktreePath: args.worktreePath,
      objective: args.objective,
      currentPlan: args.currentPlan,
      notesSnapshot: args.notesSnapshot,
      prevResults: args.prevResults,
      runState: args.runState,
      guardChain: this.guardChain,
      smartConfirmation: this.smartConfirmation,
      tasksFilePath: args.tasksFilePath,
      testCommand: args.testCommand,
      testTimeoutSec: args.testTimeoutSec,
      loopType: args.loopType,
    });
  }

  /**
   * 从 plan 阶段产出中提取当前计划文本
   *
   * @param iterationResults 当前迭代已完成的阶段结果
   * @param planTaskCard plan 阶段产出的任务卡
   * @returns 计划文本（用于 dev/verify/fix 阶段的 ctx.currentPlan）
   */
  private extractCurrentPlan(
    iterationResults: ReadonlyArray<Readonly<P5StageResult>>,
    planTaskCard: TaskCard | null
  ): string {
    if (planTaskCard !== null) {
      return `${planTaskCard.id} ${planTaskCard.title}`;
    }
    // 若 plan 阶段未产出任务卡，使用 plan 阶段的 summary 作为计划
    const planResult = iterationResults.find((r) => r.stage === "plan");
    return planResult?.summary ?? "";
  }

  // ------------------------------------------------------------------------
  // 私有方法：终止条件判定
  // ------------------------------------------------------------------------

  /**
   * 检查 stop_when 条件是否命中
   *
   * Phase 5.2 简化版判定逻辑：
   * - stopWhen 为空字符串 → 永不命中（依赖 plan 返回 taskCard=null 判定完成）
   * - stopWhen 含 "all tests pass" → 检查 verify 阶段是否 success
   * - 其他表达式 → 检查 verify 阶段是否 success（保守策略，verify 通过即视为命中）
   *
   * Phase 5.3 完整版应替换为 FakeCompletionGuard 的 G-A4b 编译期确定性判定。
   *
   * @param stopWhen stop_when 表达式
   * @param iterationResults 当前迭代的阶段结果
   * @returns true=命中停止条件；false=未命中
   */
  private checkStopWhenHit(stopWhen: string, iterationResults: ReadonlyArray<Readonly<P5StageResult>>): boolean {
    // 空表达式 → 永不命中
    if (!stopWhen || stopWhen.trim().length === 0) {
      return false;
    }

    // 查找 verify 阶段结果
    const verifyResult = iterationResults.find((r) => r.stage === "verify");
    if (!verifyResult || verifyResult.kind !== "success") {
      return false;
    }

    // 简化判定：verify 通过即视为命中 stop_when（保守策略）
    // Phase 5.3 完整版应解析表达式并做客观指标匹配
    return true;
  }

  /**
   * 从迭代结果中提取最后一个执行的阶段
   *
   * @param iterationResults 当前迭代的阶段结果
   * @returns 最后一个阶段（若迭代无结果返回 undefined）
   */
  private getLastExecutedStage(iterationResults: ReadonlyArray<Readonly<P5StageResult>>): P5StageKind | undefined {
    if (iterationResults.length === 0) {
      return undefined;
    }
    return iterationResults[iterationResults.length - 1]!.stage;
  }

  /**
   * 计算已完成的阶段列表（用于 RunState.completedStages）
   *
   * @param iterationResults 当前迭代的阶段结果
   * @param status 当前运行状态
   * @returns 已完成的阶段列表（按 P5_STAGE_ORDER 顺序）
   */
  private computeCompletedStages(
    iterationResults: ReadonlyArray<Readonly<P5StageResult>>,
    status: "running" | "completed" | "failed" | "aborted" | "stop_when"
  ): ReadonlyArray<"plan" | "dev" | "verify" | "fix"> {
    const completed: Array<"plan" | "dev" | "verify" | "fix"> = [];
    for (const result of iterationResults) {
      if (result.kind === "success") {
        completed.push(result.stage);
      }
    }
    return Object.freeze(completed);
  }

  /**
   * 将 Orchestrator 的 finalStatus 映射为 P5RunStateStatus
   *
   * @param status Orchestrator 内部状态
   * @returns P5RunStateStatus（"running" / "completed" / "failed" / "aborted"）
   */
  private mapToRunStateStatus(
    status: "running" | "completed" | "failed" | "aborted" | "stop_when"
  ): "running" | "paused" | "completed" | "failed" | "aborted" {
    switch (status) {
      case "running":
        return "running";
      case "completed":
      case "stop_when":
        return "completed";
      case "failed":
        return "failed";
      case "aborted":
        return "aborted";
      default:
        return "running";
    }
  }

  /**
   * 根据 finalStatus 计算退出码
   *
   * @param finalStatus 最终状态
   * @returns 退出码（0/1/2/3）
   */
  private computeExitCode(finalStatus: "completed" | "failed" | "aborted" | "stop_when"): 0 | 1 | 2 | 3 {
    switch (finalStatus) {
      case "completed":
        return 0;
      case "failed":
        return 1;
      case "aborted":
        return 2;
      case "stop_when":
        return 3;
      default:
        return 1;
    }
  }

  // ------------------------------------------------------------------------
  // 私有方法：状态持久化与笔记追加（带错误兜底）
  // ------------------------------------------------------------------------

  /**
   * 安全加载 notes.md 内容（错误兜底，不抛异常）
   *
   * @param runId run-id
   * @param projectRoot 项目根目录
   * @returns notes 内容（加载失败返回空字符串）
   */
  private async safeLoadNotes(runId: string, projectRoot: string): Promise<string> {
    try {
      return await this.notesMemory.loadNotes(runId, projectRoot);
    } catch (err) {
      this.log(`AutonomousOrchestrator 加载 notes 失败（兜底返回空字符串）：${(err as Error).message}`, "warn");
      return "";
    }
  }

  /**
   * 安全保存 RunState 快照（错误兜底，不抛异常）
   *
   * @param currentState 当前状态
   * @param updates 状态更新字段
   * @returns 新状态（保存失败返回 null）
   */
  private async safeSaveRunState(
    currentState: Readonly<P5RunState>,
    updates: Readonly<{
      iterIndex: number;
      currentStage: "plan" | "dev" | "verify" | "fix";
      completedStages: ReadonlyArray<"plan" | "dev" | "verify" | "fix">;
      completedLoops: ReadonlyArray<P5LoopType>;
      totalLlmCallCount: number;
      totalTokensUsed: number;
      consecutiveFailures: number;
      lastGuardTriggered: string | null;
      status: "running" | "paused" | "completed" | "failed" | "aborted";
    }>
  ): Promise<Readonly<P5RunState> | null> {
    try {
      const newState = await this.runStateStore.save({
        ...currentState,
        iterIndex: updates.iterIndex,
        currentStage: updates.currentStage,
        completedStages: updates.completedStages,
        completedLoops: updates.completedLoops,
        totalLlmCallCount: updates.totalLlmCallCount,
        totalTokensUsed: updates.totalTokensUsed,
        consecutiveFailures: updates.consecutiveFailures,
        lastGuardTriggered: updates.lastGuardTriggered,
        status: updates.status,
      });
      return newState;
    } catch (err) {
      this.log(`AutonomousOrchestrator 保存 RunState 失败（兜底返回 null）：${(err as Error).message}`, "error");
      return null;
    }
  }

  /**
   * 安全追加 notes 段落（错误兜底，不抛异常）
   *
   * @param runId run-id
   * @param projectRoot 项目根目录
   * @param info 迭代信息
   */
  private async safeAppendNotes(
    runId: string,
    projectRoot: string,
    info: {
      readonly iterIndex: number;
      readonly iterationResults: ReadonlyArray<Readonly<P5StageResult>>;
      readonly iterationFatal: boolean;
      readonly iterationFailed: boolean;
      readonly status: string;
      readonly finalStatus: string;
    }
  ): Promise<void> {
    try {
      const body = this.formatIterationNotes(info);
      await this.notesMemory.appendNote(runId, projectRoot, {
        title: `Iter ${info.iterIndex} / 多阶段`,
        body,
        timestamp: new Date().toISOString(),
        iterIndex: info.iterIndex,
        stage: this.getLastExecutedStage(info.iterationResults) ?? "plan",
        tags: Object.freeze(info.iterationFatal ? ["fatal"] : info.iterationFailed ? ["failed"] : ["success"]),
      });
    } catch (err) {
      this.log(`AutonomousOrchestrator 追加 notes 失败（兜底跳过）：${(err as Error).message}`, "warn");
    }
  }

  // ------------------------------------------------------------------------
  // 私有方法：报告生成
  // ------------------------------------------------------------------------

  /**
   * 格式化迭代摘要（用于 milestone）
   *
   * @param iterationResults 当前迭代的阶段结果
   * @param allSuccess 是否全部成功
   * @returns 摘要字符串
   */
  private formatIterationSummary(
    iterationResults: ReadonlyArray<Readonly<P5StageResult>>,
    allSuccess: boolean
  ): string {
    const parts: string[] = [];
    for (const result of iterationResults) {
      parts.push(`${result.stage}=${result.kind}`);
    }
    const summary = parts.join(", ");
    return allSuccess ? `4 阶段全绿（${summary}）` : `部分失败（${summary}）`;
  }

  /**
   * 格式化迭代笔记内容
   *
   * @param info 迭代信息
   * @returns markdown 格式的笔记内容
   */
  private formatIterationNotes(info: {
    readonly iterIndex: number;
    readonly iterationResults: ReadonlyArray<Readonly<P5StageResult>>;
    readonly iterationFatal: boolean;
    readonly iterationFailed: boolean;
    readonly status: string;
    readonly finalStatus: string;
  }): string {
    const lines: string[] = [];
    lines.push(`**迭代 ${info.iterIndex} 执行记录**`);
    lines.push("");
    lines.push(`- 状态：${info.status}`);
    lines.push(`- 最终状态：${info.finalStatus}`);
    lines.push(`- 是否致命错误：${info.iterationFatal ? "是" : "否"}`);
    lines.push(`- 是否部分失败：${info.iterationFailed ? "是" : "否"}`);
    lines.push("");
    lines.push("**阶段执行结果：**");
    lines.push("");
    for (const result of info.iterationResults) {
      lines.push(`- ${result.stage}：${result.kind}（${result.summary}）`);
      if (result.error) {
        lines.push(`  - 错误：${result.error.slice(0, 200)}`);
      }
    }
    return lines.join("\n");
  }

  /**
   * 生成最终报告（Markdown 格式）
   *
   * @param args 报告参数
   * @returns Markdown 格式的最终报告
   */
  private generateFinalReport(args: {
    readonly runId: string;
    readonly objective: string;
    readonly finalStatus: "completed" | "failed" | "aborted" | "stop_when";
    readonly exitCode: 0 | 1 | 2 | 3;
    readonly totalIterations: number;
    readonly totalLlmCallCount: number;
    readonly totalTokensUsed: number;
    readonly durationSec: number;
    readonly milestones: ReadonlyArray<Readonly<P5MilestoneRecord>>;
    readonly triggeredGuards: ReadonlyArray<GuardRecord>;
    readonly consecutiveFailures: number;
    readonly maxIterations: number;
    readonly lastFatalStage: P5StageKind | null;
    readonly lastFatalReason: string;
  }): string {
    const lines: string[] = [];
    lines.push(`# EAG-P5 AutonomousOrchestrator 运行报告`);
    lines.push("");
    lines.push(`- **run-id**：${args.runId}`);
    lines.push(`- **目标**：${args.objective}`);
    lines.push(`- **最终状态**：${args.finalStatus}`);
    lines.push(`- **退出码**：${args.exitCode}`);
    lines.push(`- **迭代次数**：${args.totalIterations}/${args.maxIterations}`);
    lines.push(`- **LLM 调用次数**：${args.totalLlmCallCount}`);
    lines.push(`- **Token 消耗**：${args.totalTokensUsed}`);
    lines.push(`- **总耗时**：${args.durationSec} 秒`);
    lines.push(`- **连续失败次数**：${args.consecutiveFailures}`);
    lines.push(`- **里程碑数**：${args.milestones.length}`);
    lines.push(`- **触发护栏数**：${args.triggeredGuards.length}`);
    lines.push("");

    if (args.lastFatalStage !== null) {
      lines.push(`## 致命错误`);
      lines.push("");
      lines.push(`- **最后致命阶段**：${args.lastFatalStage}`);
      lines.push(`- **原因**：${args.lastFatalReason}`);
      lines.push("");
    }

    if (args.milestones.length > 0) {
      lines.push(`## 里程碑列表`);
      lines.push("");
      for (const m of args.milestones) {
        lines.push(`- **m${m.index}**：${m.name}（${m.completedAt}）— ${m.summary}`);
      }
      lines.push("");
    }

    if (args.triggeredGuards.length > 0) {
      lines.push(`## 触发的护栏记录`);
      lines.push("");
      for (const g of args.triggeredGuards) {
        lines.push(`- **${g.ruleId}**（${g.severity}/${g.decision}）iter=${g.iterIndex} stage=${g.stage}：${g.reason}`);
      }
      lines.push("");
    }

    return lines.join("\n");
  }

  /**
   * 生成阻塞分析报告（finalStatus=aborted/failed 时调用）
   *
   * @param args 报告参数
   * @returns 阻塞分析报告（冻结对象）
   */
  private generateBlockageReport(args: {
    readonly runId: string;
    readonly iterIndex: number;
    readonly loopType: P5LoopType;
    readonly lastFatalStage: P5StageKind | null;
    readonly lastFatalReason: string;
    readonly consecutiveFailures: number;
    readonly triggeredGuards: ReadonlyArray<GuardRecord>;
  }): Readonly<P5BlockageReport> {
    const rootCauseHypotheses: string[] = [];
    const suggestedSolutions: string[] = [];

    // 根因假设生成
    if (args.lastFatalStage !== null) {
      rootCauseHypotheses.push(`${args.lastFatalStage} 阶段发生致命错误：${args.lastFatalReason}`);
    }
    if (args.consecutiveFailures > 0) {
      rootCauseHypotheses.push(
        `连续失败 ${args.consecutiveFailures} 次，可能存在系统性问题（如测试命令错误 / 任务卡配置问题）`
      );
    }
    if (args.triggeredGuards.length > 0) {
      const guardIds = [...new Set(args.triggeredGuards.map((g) => g.ruleId))];
      rootCauseHypotheses.push(`触发了 ${args.triggeredGuards.length} 条护栏记录，涉及规则：${guardIds.join(", ")}`);
    }
    if (rootCauseHypotheses.length === 0) {
      rootCauseHypotheses.push("迭代次数用尽但未识别明确根因");
    }

    // 建议方案生成
    if (args.lastFatalStage === "plan") {
      suggestedSolutions.push("检查 tasks.md 格式与任务卡完整性");
      suggestedSolutions.push("确认任务卡依赖关系是否成环");
    } else if (args.lastFatalStage === "dev") {
      suggestedSolutions.push("检查任务卡声明的文件路径是否在 projectRoot 内");
      suggestedSolutions.push("确认无凭据文件（.env / secrets / .ssh 等）被声明");
    } else if (args.lastFatalStage === "verify") {
      suggestedSolutions.push("检查测试命令是否可执行（如 npm test 是否配置）");
      suggestedSolutions.push("确认测试命令不命中 G-A2a 黑名单");
    } else if (args.lastFatalStage === "fix") {
      suggestedSolutions.push("检查 fix 阶段是否触发 G-A3b 清理意图拦截");
    }
    if (args.consecutiveFailures >= 3) {
      suggestedSolutions.push("考虑调整任务目标或拆分为更小粒度的任务卡");
    }
    if (suggestedSolutions.length === 0) {
      suggestedSolutions.push("检查日志与 notes.md 获取详细执行记录");
    }

    const summary =
      args.lastFatalStage !== null
        ? `${args.lastFatalStage} 阶段致命错误（连续失败 ${args.consecutiveFailures} 次）`
        : `连续失败 ${args.consecutiveFailures} 次触发 abort`;

    return Object.freeze({
      runId: args.runId,
      generatedAt: new Date().toISOString(),
      blockedLoop: args.loopType,
      blockedIteration: args.iterIndex,
      blockedStage: args.lastFatalStage ?? "plan",
      rootCauseHypotheses: Object.freeze([...rootCauseHypotheses]),
      suggestedSolutions: Object.freeze([...suggestedSolutions]),
      summary,
    });
  }
}

// ============================================================================
// 5. 工厂函数
// ============================================================================

/**
 * 工厂函数：创建默认 AutonomousOrchestrator 实例
 *
 * @param options 构造选项
 * @returns AutonomousOrchestrator 实例
 * @throws Error 核心依赖缺失时抛出
 */
export function createAutonomousOrchestrator(options: Readonly<AutonomousOrchestratorOptions>): AutonomousOrchestrator {
  return new AutonomousOrchestrator(options);
}

// ============================================================================
// 6. 导出常量（供测试断言）
// ============================================================================

/**
 * 导出默认配置常量（供测试断言与文档对齐）
 */
export {
  DEFAULT_MAX_ITERATIONS as AUTONOMOUS_DEFAULT_MAX_ITERATIONS,
  DEFAULT_MAX_TOKENS as AUTONOMOUS_DEFAULT_MAX_TOKENS,
  DEFAULT_CONSECUTIVE_FAILURE_ABORT as AUTONOMOUS_DEFAULT_CONSECUTIVE_FAILURE_ABORT,
  DEFAULT_TEST_COMMAND as AUTONOMOUS_DEFAULT_TEST_COMMAND,
  DEFAULT_TEST_TIMEOUT_SEC as AUTONOMOUS_DEFAULT_TEST_TIMEOUT_SEC,
  DEFAULT_STOP_WHEN as AUTONOMOUS_DEFAULT_STOP_WHEN,
  DEFAULT_INITIAL_LOOP as AUTONOMOUS_DEFAULT_INITIAL_LOOP,
  DEFAULT_TASKS_FILENAME as AUTONOMOUS_DEFAULT_TASKS_FILENAME,
  DEFAULT_TASKS_DIR as AUTONOMOUS_DEFAULT_TASKS_DIR,
};
