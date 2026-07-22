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

import type { BlockerGuardChain } from "./guards/blocker-guard-chain";
import type { GuardRecord } from "./guards/types";
import type { TaskCard } from "./guards/types";
import type { P5RunStateStore, P5RunState, P5LoopType } from "./run-state-store";
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

    // 3. 初始化 RunState 持久化存储
    const initialState = await this.runStateStore.initialize({
      projectRoot,
      objective,
      runId: request.runId,
      initialLoop,
      maxIterations,
      maxTokens,
      stopWhen,
    });

    const runId = initialState.runId;
    this.log(`AutonomousOrchestrator.run 已初始化 RunState：runId=${runId}`, "info");

    // 4. 初始化累计统计变量
    let currentRunState: Readonly<P5RunState> = initialState;
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

    // 5. 主循环
    while (iterIndex < maxIterations && status === "running") {
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
          this.log(`AutonomousOrchestrator.run 迭代 ${iterIndex} 检测到 plan 返回 taskCard=null，全部任务完成`, "info");
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

    const result: AutonomousRunResult = Object.freeze({
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

    return result;
  }

  // ------------------------------------------------------------------------
  // 私有方法：请求校验与配置解析
  // ------------------------------------------------------------------------

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
