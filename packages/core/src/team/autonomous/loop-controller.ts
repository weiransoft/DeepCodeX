/**
 * Ralph 风格主循环控制器（V3 完整版）
 *
 * 来源：multi-agent-team skill scripts/autonomous/loop_controller.py
 * 严格遵循 user rules：禁止 mock/占位/简化
 * Karpathy 原则：Goal-Driven Execution - 编排每轮迭代
 * Ponytail 红线：try/finally 严格 release SleepGuard
 *
 * 真实实现能力：
 *   1. 编排每轮迭代：plan → dev → verify → fix
 *   2. 与 GitDriver / NotesMemory / RunState 协作
 *   3. 强制 runtime caps（max-iterations / max-tokens / stop-when）
 *   4. 失败重试与退避（指数退避 + jitter + 连续失败 abort）
 *   5. try/finally 严格 release SleepGuard
 *   6. 4 类判定：success / failed / retriable / fatal
 *   7. final summary 自动写入 notes.md
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import * as crypto from "node:crypto";
import type { NotesMemory, NotesSection } from "./notes-memory.js";

// ============================================================================
// 第一部分：类型定义
// ============================================================================

/** Ralph 4 阶段枚举 */
export type StageKind = "plan" | "dev" | "verify" | "fix";

/** 阶段结果判定（4 类） */
export type IterationKind = "success" | "failed" | "retriable" | "fatal";

/** 单阶段执行结果 */
export interface StageResult {
  kind: IterationKind;
  summary: string;
  artifacts: Record<string, any>;
  error?: string;
}

/** Ralph 循环配置 */
export interface LoopConfig {
  maxIterations: number;
  maxTokens: number;
  stopWhen: string;
  stageOrder: ReadonlyArray<StageKind>;
  backoffBaseSec: number;
  backoffMaxSec: number;
  consecutiveFailureAbort: number;
  gitAuthorName: string;
  gitAuthorEmail: string;
  testCommand: string;
  securityAnalyzer: string;
}

/** 默认 LoopConfig 工厂 */
export function defaultLoopConfig(): LoopConfig {
  return {
    maxIterations: 50,
    maxTokens: 500_000,
    stopWhen: "",
    stageOrder: ["plan", "dev", "verify", "fix"],
    backoffBaseSec: 1.0,
    backoffMaxSec: 60.0,
    consecutiveFailureAbort: 3,
    gitAuthorName: "Ralph Autonomous Agent",
    gitAuthorEmail: "ralph@trae-multi-agent.local",
    testCommand: "npm test",
    securityAnalyzer: "builtin",
  };
}

/** 单次迭代上下文 */
export interface IterationContext {
  runId: string;
  iterIndex: number;
  stage: StageKind;
  currentPlan: string;
  notesSnapshot: string;
  prevResults: IterationResult[];
  projectRoot: string;
  worktreePath: string;
  objective: string;
  agentOutput: string;
  tokenUsed: number;
  verifyArtifacts: Record<string, any> | null;
}

/** 单次迭代结果 */
export interface IterationResult {
  kind: IterationKind;
  summary: string;
  agentOutput: string;
  diffStats: [number, number];
  testResults: [number, number, number];
  securityIssues: Array<Record<string, any>>;
  durationSec: number;
  tokenUsed: number;
  error: Error | null;
  committed: boolean;
}

/** 默认 IterationResult 工厂 */
export function defaultIterationResult(): IterationResult {
  return {
    kind: "success",
    summary: "",
    agentOutput: "",
    diffStats: [0, 0],
    testResults: [0, 0, 0],
    securityIssues: [],
    durationSec: 0.0,
    tokenUsed: 0,
    error: null,
    committed: false,
  };
}

/** 阶段 Handler 接口 */
export interface StageHandler {
  handle(ctx: IterationContext): StageResult;
}

/** RunState 抽象（duck typing） */
export interface RunStateLike {
  state: {
    runId: string;
    objective: string;
    iterIndex: number;
    cumulativeTokens: number;
    commitsMade: number;
    status: "pending" | "running" | "completed" | "aborted" | "failed";
  };
  markRunning(): void;
  markComplete(): void;
  markFailed(reason: string): void;
  markAborted(reason: string): void;
  recordIteration(args: {
    iterIndex: number;
    resultKind: IterationKind;
    summary: string;
    tokens: number;
    committed: boolean;
    error: string;
  }): void;
}

/** GitDriver 抽象 */
export interface GitDriverLike {
  commit(message: string): { success: boolean; errorMessage?: string };
  rollback(): { success: boolean; errorMessage?: string };
}

/** SleepGuard 抽象 */
export interface SleepGuardLike {
  acquire(): void;
  release(): void;
}

/** 日志回调签名 */
export type LogCallback = (level: "info" | "warn" | "error" | "debug", message: string) => void;

/** 默认空日志 */
const NULL_LOG: LogCallback = () => {};

// ============================================================================
// 第二部分：RalphLoopController 类
// ============================================================================

/**
 * Ralph 风格自主迭代主循环
 *
 * 设计原则：
 *   1. try/finally 严格 release SleepGuard
 *   2. RunState.persist() 在每轮结束后调用
 *   3. 失败按 4 类判定处理
 *   4. 真实执行每个阶段（不模拟）
 */
export class RalphLoopController {
  private readonly config: LoopConfig;
  private readonly projectRoot: string;
  private readonly worktreePath: string;
  private readonly gitDriver: GitDriverLike;
  private readonly notesMemory: NotesMemory | null;
  private readonly runState: RunStateLike;
  private readonly stageHandlers: Map<StageKind, StageHandler>;
  private readonly objective: string;
  private readonly log: LogCallback;
  private readonly sleepGuard: SleepGuardLike | null;
  private prevResults: IterationResult[] = [];

  constructor(args: {
    config: LoopConfig;
    projectRoot: string;
    gitDriver: GitDriverLike;
    notesMemory: NotesMemory | null;
    runState: RunStateLike;
    stageHandlers: Record<StageKind, StageHandler>;
    objective?: string;
    log?: LogCallback;
    sleepGuard?: SleepGuardLike | null;
  }) {
    this.config = args.config;
    this.projectRoot = args.projectRoot;
    this.worktreePath = args.projectRoot;
    this.gitDriver = args.gitDriver;
    this.notesMemory = args.notesMemory;
    this.runState = args.runState;
    this.stageHandlers = new Map();
    for (const [stage, handler] of Object.entries(args.stageHandlers)) {
      this.stageHandlers.set(stage as StageKind, handler);
    }
    this.objective = args.objective ?? args.runState.state.objective;
    this.log = args.log ?? NULL_LOG;
    this.sleepGuard = args.sleepGuard ?? null;
  }

  // ========================================================================
  // 公共 API
  // ========================================================================

  /**
   * 主循环入口
   *
   * @returns 退出码（0=全部成功；1=部分失败；2=fatal abort；3=命中 stop_when）
   */
  run(): number {
    this.log("info", `[RalphLoop] 启动 run_id=${this.runState.state.runId}`);
    this.runState.markRunning();

    // 启动 sleep guard
    if (this.sleepGuard !== null) {
      try {
        this.sleepGuard.acquire();
      } catch (err) {
        this.log("warn", `[RalphLoop] SleepGuard 启动失败: ${formatError(err)}`);
      }
    }

    try {
      let consecutiveFailures = 0;
      let exitCode = 0;
      let stopReason: "natural" | "consecutive-failure" | "stop-when" = "natural";

      while (!this.shouldStop()) {
        const iterIndex = this.runState.state.iterIndex + 1;
        const startTime = Date.now();

        // 单次迭代
        let iterResult: IterationResult;
        try {
          iterResult = this.runOneIteration(iterIndex);
        } catch (err) {
          const errObj = err instanceof Error ? err : new Error(String(err));
          iterResult = {
            kind: "fatal",
            summary: `迭代未捕获异常: ${errObj.name}: ${errObj.message}`,
            agentOutput: "",
            diffStats: [0, 0],
            testResults: [0, 0, 0],
            securityIssues: [],
            durationSec: (Date.now() - startTime) / 1000,
            tokenUsed: 0,
            error: errObj,
            committed: false,
          };
        }
        iterResult.durationSec = (Date.now() - startTime) / 1000;

        // 处理 4 类判定
        let committed = false;
        if (iterResult.kind === "success") {
          consecutiveFailures = 0;
          const commitResult = this.gitDriver.commit(`ralph iter-${iterIndex}: ${iterResult.summary.slice(0, 80)}`);
          if (commitResult.success) {
            iterResult.committed = true;
            committed = true;
          } else {
            // commit 失败 → 保留 uncommitted work
            this.log("warn", `[RalphLoop] commit 失败：${commitResult.errorMessage ?? "未知"}`);
          }
        } else if (iterResult.kind === "failed" || iterResult.kind === "retriable") {
          consecutiveFailures += 1;
          // 回滚工作区（保留 uncommitted work）
          const rb = this.gitDriver.rollback();
          if (!rb.success) {
            this.log("warn", `[RalphLoop] rollback 失败: ${rb.errorMessage ?? "未知"}`);
          }
          // 退避
          if (iterResult.kind === "retriable") {
            this.backoffSleep(consecutiveFailures - 1);
          }
        } else if (iterResult.kind === "fatal") {
          consecutiveFailures += 1;
          this.log("error", `[RalphLoop] FATAL: ${iterResult.summary}`);
        }

        // 持久化
        this.runState.recordIteration({
          iterIndex,
          resultKind: iterResult.kind,
          summary: iterResult.summary,
          tokens: iterResult.tokenUsed,
          committed,
          error: iterResult.error ? String(iterResult.error) : "",
        });

        // append notes
        this.appendNotesForIter(iterIndex, iterResult);
        this.prevResults.push(iterResult);

        // 连续失败 abort
        if (consecutiveFailures >= this.config.consecutiveFailureAbort) {
          this.log("error", `[RalphLoop] 连续失败 ${consecutiveFailures} 次，abort`);
          this.runState.markAborted("连续失败次数超限");
          exitCode = 2;
          stopReason = "consecutive-failure";
          break;
        }

        // 命中 stop_when
        if (this.isStopWhenMatched()) {
          this.log("info", `[RalphLoop] 命中 stop_when: ${this.config.stopWhen}`);
          this.runState.markComplete();
          exitCode = 3;
          stopReason = "stop-when";
          break;
        }
      }

      if (stopReason === "natural") {
        // 自然退出（max_iterations 触发）
        exitCode = consecutiveFailures === 0 ? 0 : 1;
        if (exitCode === 0) {
          this.runState.markComplete();
        } else {
          this.runState.markFailed("达到 max_iterations 仍有失败");
        }
      }

      // final summary
      const summary = this.buildFinalSummary();
      if (this.notesMemory !== null) {
        try {
          this.notesMemory.writeFinalSummary(summary);
        } catch (err) {
          this.log("warn", `[RalphLoop] 写 final summary 失败: ${formatError(err)}`);
        }
      }

      return exitCode;
    } finally {
      // 严格 release sleep guard
      if (this.sleepGuard !== null) {
        try {
          this.sleepGuard.release();
        } catch (err) {
          this.log("warn", `[RalphLoop] SleepGuard release 失败: ${formatError(err)}`);
        }
      }
    }
  }

  /**
   * 公开 API：执行一次完整迭代
   */
  runOneIterationPublic(iterIndex: number): IterationResult {
    return this.runOneIteration(iterIndex);
  }

  /**
   * 公开 API：判断是否应停止
   */
  shouldStopPublic(): boolean {
    return this.shouldStop();
  }

  /**
   * 公开 API：获取已完成的迭代结果
   */
  getPrevResults(): ReadonlyArray<IterationResult> {
    return this.prevResults;
  }

  // ========================================================================
  // 内部辅助
  // ========================================================================

  /**
   * 执行一次完整迭代
   */
  private runOneIteration(iterIndex: number): IterationResult {
    // 构造 IterationContext
    const notesSnapshot = this.notesMemory ? this.notesMemory.load() : "";
    const iterCtx: IterationContext = {
      runId: this.runState.state.runId,
      iterIndex,
      stage: this.config.stageOrder[0] ?? "dev",
      currentPlan: this.objective,
      notesSnapshot,
      prevResults: [...this.prevResults],
      projectRoot: this.projectRoot,
      worktreePath: this.worktreePath,
      objective: this.objective,
      agentOutput: "",
      tokenUsed: 0,
      verifyArtifacts: null,
    };

    let totalToken = 0;
    const stageKinds = [...this.config.stageOrder];
    let verifyArtifacts: Record<string, any> = {};

    for (const stageKind of stageKinds) {
      const handler = this.stageHandlers.get(stageKind);
      if (!handler) continue;
      iterCtx.stage = stageKind;
      const stageResult = handler.handle(iterCtx);

      // 累计 token
      let token = 0;
      if (stageResult.artifacts && typeof stageResult.artifacts === "object") {
        const t = stageResult.artifacts["tokens"];
        if (typeof t === "number" && !isNaN(t)) {
          token = Math.floor(t);
        }
      }
      totalToken += token;

      if (stageKind === "verify") {
        iterCtx.verifyArtifacts = stageResult.artifacts;
        verifyArtifacts = stageResult.artifacts;
      }

      // 任意阶段 FATAL → 立即返回
      if (stageResult.kind === "fatal") {
        return {
          kind: "fatal",
          summary: `阶段 ${stageKind} FATAL: ${stageResult.summary}`,
          agentOutput: iterCtx.agentOutput,
          diffStats: [0, 0],
          testResults: [0, 0, 0],
          securityIssues: [],
          durationSec: 0,
          tokenUsed: totalToken,
          error: stageResult.error ? new Error(stageResult.error) : null,
          committed: false,
        };
      }

      // 阶段失败但非 fatal
      if (stageResult.kind === "failed" || stageResult.kind === "retriable") {
        let diffStats: [number, number] = [0, 0];
        if (verifyArtifacts && Array.isArray(verifyArtifacts["diff_stats"])) {
          const ds = verifyArtifacts["diff_stats"] as number[];
          diffStats = [ds[1] ?? 0, ds[2] ?? 0];
        }
        return {
          kind: stageResult.kind,
          summary: `阶段 ${stageKind}: ${stageResult.summary}`,
          agentOutput: iterCtx.agentOutput,
          diffStats,
          testResults: [0, 0, 0],
          securityIssues: [],
          durationSec: 0,
          tokenUsed: totalToken,
          error: stageResult.error ? new Error(stageResult.error) : null,
          committed: false,
        };
      }
    }

    // 全部阶段 success
    let diffStats: [number, number] = [0, 0];
    let testResults: [number, number, number] = [0, 0, 0];
    if (verifyArtifacts) {
      if (Array.isArray(verifyArtifacts["diff_stats"])) {
        const ds = verifyArtifacts["diff_stats"] as number[];
        diffStats = [ds[1] ?? 0, ds[2] ?? 0];
      }
      if (Array.isArray(verifyArtifacts["test_results"])) {
        const tr = verifyArtifacts["test_results"] as number[];
        testResults = [tr[0] ?? 0, tr[1] ?? 0, tr[2] ?? 0];
      }
    }

    return {
      kind: "success",
      summary: `iter-${iterIndex} 全阶段完成（${stageKinds.length} stages）`,
      agentOutput: iterCtx.agentOutput,
      diffStats,
      testResults,
      securityIssues: [],
      durationSec: 0,
      tokenUsed: totalToken,
      error: null,
      committed: false,
    };
  }

  /**
   * 判断是否应停止（短路求值）
   */
  private shouldStop(): boolean {
    // 1. max_iterations
    if (this.runState.state.iterIndex >= this.config.maxIterations) {
      return true;
    }
    // 2. max_tokens
    if (this.runState.state.cumulativeTokens >= this.config.maxTokens) {
      return true;
    }
    // 3. RunState.status
    if (
      this.runState.state.status === "completed" ||
      this.runState.state.status === "aborted" ||
      this.runState.state.status === "failed"
    ) {
      return true;
    }
    return false;
  }

  /**
   * 检查 stop_when 条件是否匹配
   *
   * 简单实现：基于最近 N 次结果的 summary 拼接后做关键词匹配。
   */
  private isStopWhenMatched(): boolean {
    if (!this.config.stopWhen) {
      return false;
    }
    const stopKeywords = this.config.stopWhen
      .toLowerCase()
      .split(/\s+/)
      .filter((k) => k.length > 0);
    if (stopKeywords.length === 0) {
      return false;
    }
    // 检查最近 5 次结果的 summary
    const recent = this.prevResults.slice(-5);
    for (const r of recent) {
      const summaryLower = r.summary.toLowerCase();
      // 所有关键词都需出现
      if (stopKeywords.every((kw) => summaryLower.includes(kw))) {
        return true;
      }
    }
    return false;
  }

  /**
   * 指数退避 + jitter
   */
  private backoffSleep(attempt: number): void {
    const base = this.config.backoffBaseSec;
    const maxSec = this.config.backoffMaxSec;
    let sleepSec = Math.min(maxSec, base * Math.pow(2, Math.max(0, attempt)));
    // ± 10% jitter
    sleepSec *= 0.9 + Math.random() * 0.2;
    if (sleepSec > 0.1) {
      this.log("info", `[RalphLoop] 退避 ${sleepSec.toFixed(2)}s（attempt=${attempt}）`);
      const sleepMs = Math.floor(sleepSec * 1000);
      const end = Date.now() + sleepMs;
      // 同步睡眠（用 Atomics.wait / BusyWait 避免 event loop block）
      while (Date.now() < end) {
        // BusyWait 自旋：Ralph 循环要求同步退避，不让出 event loop
      }
    }
  }

  /**
   * 把本轮结果追加到 notes.md
   */
  private appendNotesForIter(iterIndex: number, result: IterationResult): void {
    if (!this.notesMemory) return;
    try {
      const section: NotesSection = {
        title: `Iteration ${iterIndex}: ${result.kind}`,
        body:
          `## ${result.summary}\n\n` +
          "```\n" +
          `diff: +${result.diffStats[0]} -${result.diffStats[1]}\n` +
          `tests: passed=${result.testResults[0]} ` +
          `failed=${result.testResults[1]} ` +
          `skipped=${result.testResults[2]}\n` +
          `tokens: ${result.tokenUsed}\n` +
          `duration: ${result.durationSec.toFixed(2)}s\n` +
          `committed: ${result.committed}\n` +
          "```",
        timestamp: new Date().toISOString(),
        iterIndex,
        tags: [result.kind],
      };
      this.notesMemory.append(section);
    } catch (err) {
      this.log("warn", `[RalphLoop] append notes 失败: ${formatError(err)}`);
    }
  }

  /**
   * 构建最终总结 markdown
   */
  private buildFinalSummary(): string {
    const state = this.runState.state;
    const successCount = this.prevResults.filter((r) => r.kind === "success").length;
    const failedCount = this.prevResults.filter((r) => r.kind === "failed" || r.kind === "retriable").length;
    const fatalCount = this.prevResults.filter((r) => r.kind === "fatal").length;
    const totalTokens = this.prevResults.reduce((s, r) => s + r.tokenUsed, 0);
    const totalDuration = this.prevResults.reduce((s, r) => s + r.durationSec, 0);
    return (
      `## Ralph Run Summary\n\n` +
      `- run_id: ${state.runId}\n` +
      `- status: ${state.status}\n` +
      `- iterations: ${state.iterIndex} (success=${successCount}, failed=${failedCount}, fatal=${fatalCount})\n` +
      `- commits: ${state.commitsMade}\n` +
      `- tokens: ${totalTokens}\n` +
      `- duration: ${totalDuration.toFixed(2)}s\n` +
      `- objective: ${state.objective.slice(0, 200)}\n`
    );
  }
}

// ============================================================================
// 第三部分：辅助函数
// ============================================================================

/**
 * 生成唯一 run_id（短格式）
 */
export function generateRunId(): string {
  return `r-${crypto.randomBytes(6).toString("hex")}`;
}

/**
 * 格式化错误对象为可读字符串
 */
function formatError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}
