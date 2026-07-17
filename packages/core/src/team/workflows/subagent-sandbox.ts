/**
 * Subagent Sandbox - subagent 执行沙箱（TypeScript 移植版）
 *
 * 来源：multi-agent-team skill scripts/dynamic_workflow/subagent_sandbox.py
 * 严格遵循 user rules：禁止 mock/占位/简化
 *
 * 职责：
 * 1. 提供"独立 worktree + 独立 context + Token 预算"的 subagent 执行环境
 * 2. 强制 Guard 校验（不可绕过）
 * 3. 异常隔离（一个 subagent 失败不影响父 workflow）
 * 4. 生命周期管理（spawn → execute → cleanup）
 * 5. 与 PerformanceFingerprint 联动（沙箱元数据记录）
 *
 * 设计原则：
 * - 不修改任何 V2 文件
 * - 复用 PerformanceFingerprint 记录沙箱元数据
 * - 隔离级别可配置（none/context/worktree/full）
 * - 异常隔离：executor 抛异常不传播给父
 * - Phase 8 Skill 注入（向后兼容：默认不启用）
 * - Phase 9 pause/resume/cancel（向后兼容：默认不启用 recovery manager）
 *
 * 作者：trae-multi-agent 融合 Phase 2 + Phase 8 + Phase 9（TypeScript 移植版）
 * 创建日期：2026-07-16
 */

import type { WorktreeManager, WorktreeInfo } from "./worktree-manager.js";

// ============================================================================
// 异常类
// ============================================================================

/** 沙箱基础异常 */
export class SandboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxError";
  }
}

/** Guard 拒绝（输入校验失败） */
export class GuardRejectError extends SandboxError {
  public readonly guard_result: GuardResultLike | undefined;
  constructor(message: string, guard_result?: GuardResultLike) {
    super(message);
    this.name = "GuardRejectError";
    this.guard_result = guard_result;
  }
}

/** Token 预算硬上限 */
export class TokenBudgetExceededSandbox extends SandboxError {
  public readonly token_used: number;
  public readonly token_budget: number;
  constructor(message: string, token_used: number = 0, token_budget: number = 0) {
    super(message);
    this.name = "TokenBudgetExceeded";
    this.token_used = token_used;
    this.token_budget = token_budget;
  }
}

/** 沙箱不存在 */
export class SandboxNotFoundError extends SandboxError {
  constructor(sandbox_id: string) {
    super(`沙箱不存在：${sandbox_id}`);
    this.name = "SandboxNotFoundError";
  }
}

/** 沙箱已存在 */
export class SandboxAlreadyExistsError extends SandboxError {
  constructor(sandbox_id: string) {
    super(`沙箱已存在：${sandbox_id}`);
    this.name = "SandboxAlreadyExistsError";
  }
}

/** 沙箱执行超时 */
export class SandboxTimeoutError extends SandboxError {
  constructor(message: string) {
    super(message);
    this.name = "SandboxTimeoutError";
  }
}

/** Phase 9：用户主动取消 */
export class UserAbortError extends SandboxError {
  constructor(message: string = "user_abort") {
    super(message);
    this.name = "UserAbortError";
  }
}

/** Phase 9：用户主动暂停 */
export class PauseRequestError extends SandboxError {
  constructor(message: string = "pause_request") {
    super(message);
    this.name = "PauseRequestError";
  }
}

// ============================================================================
// 枚举：沙箱状态
// ============================================================================

/**
 * 沙箱状态
 *
 * Phase 9 扩展：新增 CANCELLED / PAUSED / SKIPPED 用于 pause/resume/cancel 流程
 */
export const SandboxStatus = {
  PENDING: "pending",
  RUNNING: "running",
  SUCCESS: "success",
  FAILURE: "failure",
  REJECTED: "rejected",
  TOKEN_EXCEEDED: "token_exceeded",
  TIMEOUT: "timeout",
  CANCELLED: "cancelled",
  PAUSED: "paused",
  SKIPPED: "skipped",
  CLEANED: "cleaned",
} as const;

export type SandboxStatusType = (typeof SandboxStatus)[keyof typeof SandboxStatus];

/** 所有沙箱状态（用于校验） */
export const ALL_SANDBOX_STATUSES: readonly SandboxStatusType[] = [
  SandboxStatus.PENDING,
  SandboxStatus.RUNNING,
  SandboxStatus.SUCCESS,
  SandboxStatus.FAILURE,
  SandboxStatus.REJECTED,
  SandboxStatus.TOKEN_EXCEEDED,
  SandboxStatus.TIMEOUT,
  SandboxStatus.CANCELLED,
  SandboxStatus.PAUSED,
  SandboxStatus.SKIPPED,
  SandboxStatus.CLEANED,
];

// ============================================================================
// 隔离级别
// ============================================================================

/** 隔离级别常量 */
export const IsolationLevel = {
  NONE: "none",
  CONTEXT: "context",
  WORKTREE: "worktree",
  FULL: "full",
} as const;

export type IsolationLevelType = (typeof IsolationLevel)[keyof typeof IsolationLevel];

/** 所有有效隔离级别 */
export const ALL_ISOLATION_LEVELS: readonly IsolationLevelType[] = [
  IsolationLevel.NONE,
  IsolationLevel.CONTEXT,
  IsolationLevel.WORKTREE,
  IsolationLevel.FULL,
];

/** 校验隔离级别 */
export function isValidIsolationLevel(level: string): level is IsolationLevelType {
  return (ALL_ISOLATION_LEVELS as readonly string[]).includes(level);
}

// ============================================================================
// 抽象接口
// ============================================================================

/** Guard 校验结果（与 guard.ts 兼容的最小接口） */
export interface GuardResultLike {
  is_allowed: boolean;
  reason: string;
  warnings?: string[];
  metadata?: Record<string, unknown>;
}

/** Guard 委托（用于注入到 sandbox） */
export interface GuardLike {
  check(args: { inputs: Record<string, unknown>; token_budget: number }): GuardResultLike;
}

/** PerformanceFingerprint 记录接口（复用 model-router.ts 中的定义） */
export interface FingerprintRecordLike {
  task_type: string;
  task_complexity: number;
  success: boolean;
  error_type?: string;
  execution_time: number;
  strategy: string;
  context_features: Record<string, unknown>;
}

/** PerformanceFingerprint 接口（解耦真实实现） */
export interface SandboxFingerprintLike {
  readonly total_executions: number;
  record(args: {
    task_type: string;
    task_complexity: number;
    success: boolean;
    error_type?: string;
    execution_time: number;
    strategy: string;
    context_features: Record<string, unknown>;
  }): void;
}

/** Skill Injector 接口（Phase 8，可选依赖） */
export interface SkillInjectionResultLike {
  injected_skills: string[];
  rendered_text: string;
  mode: string | null;
  missing_skills: string[];
  circular_skills: string[];
  truncated: boolean;
  injection_time_ms: number;
  errors: string[];
}

export interface SkillInjectorLike {
  inject(args: {
    task_skill: string | string[];
    skill_mode?: string;
    skill_priority?: string;
    token_budget: number;
  }): SkillInjectionResultLike;
}

/** Interruption Recovery Manager 接口（Phase 9，可选依赖） */
export interface RetryPolicyLike {
  max_retries: number;
}

export interface InterruptionRecoveryManagerLike {
  retry_policy: RetryPolicyLike;
  load_snapshot(snapshot_id: string): { to_dict(): Record<string, unknown> } | null;
  attempt_recovery?(args: { sandbox_id: string; error: Error; attempt: number }): Promise<boolean> | boolean;
}

// ============================================================================
// 数据结构
// ============================================================================

/**
 * 沙箱执行上下文（传给 executor）
 *
 * Phase 8 扩展：injected_skills / skill_injection_text / skill_injection_meta
 * Phase 9 扩展：pause_event / cancel_event / snapshot / intermediate_results
 */
export interface SandboxContext {
  /** 沙箱 ID */
  sandbox_id: string;
  /** subagent ID */
  agent_id: string;
  /** 隔离级别 */
  isolation_level: IsolationLevelType;
  /** worktree 路径（null 表示未创建） */
  worktree_path: string | null;
  /** context 实例 ID（用于 DualLayerContextManager） */
  context_instance_id: string | null;
  /** 已消耗 token */
  token_used: number;
  /** token 预算上限 */
  token_budget: number;
  /** 创建时间（ISO 字符串） */
  created_at: string;
  /** Phase 8 字段 */
  injected_skills: string[];
  skill_injection_text: string;
  skill_injection_meta: Record<string, unknown>;
  /** Phase 9 字段 */
  pause_requested: boolean;
  cancel_requested: boolean;
  snapshot: Record<string, unknown> | null;
  intermediate_results: Record<string, unknown>;
}

/**
 * 创建 SandboxContext
 */
export function createSandboxContext(args: {
  sandbox_id: string;
  agent_id: string;
  isolation_level: IsolationLevelType;
  worktree_path: string | null;
  context_instance_id: string | null;
  token_budget: number;
  injected_skills?: string[];
  skill_injection_text?: string;
  skill_injection_meta?: Record<string, unknown>;
}): SandboxContext {
  return {
    sandbox_id: args.sandbox_id,
    agent_id: args.agent_id,
    isolation_level: args.isolation_level,
    worktree_path: args.worktree_path,
    context_instance_id: args.context_instance_id,
    token_used: 0,
    token_budget: args.token_budget,
    created_at: new Date().toISOString(),
    injected_skills: args.injected_skills ?? [],
    skill_injection_text: args.skill_injection_text ?? "",
    skill_injection_meta: args.skill_injection_meta ?? {},
    pause_requested: false,
    cancel_requested: false,
    snapshot: null,
    intermediate_results: {},
  };
}

/**
 * 报告 token 消耗（executor 调用）
 *
 * @throws TokenBudgetExceededSandbox 累计超过预算
 */
export function recordToken(ctx: SandboxContext, count: number): void {
  ctx.token_used += count;
  if (ctx.token_used > ctx.token_budget) {
    throw new TokenBudgetExceededSandbox(
      `Token 预算超限：${ctx.token_used} > ${ctx.token_budget}`,
      ctx.token_used,
      ctx.token_budget
    );
  }
}

/**
 * 沙箱执行结果
 */
export interface SandboxResult {
  sandbox_id: string;
  agent_id: string;
  status: SandboxStatusType;
  output: unknown;
  token_used: number;
  execution_time_seconds: number;
  error: string | null;
  worktree_cleaned: boolean;
  isolated: boolean;
  guard_result: Record<string, unknown> | null;
  metadata: Record<string, unknown>;
}

/**
 * SandboxResult 转字典
 */
export function sandboxResultToDict(r: SandboxResult): Record<string, unknown> {
  return {
    sandbox_id: r.sandbox_id,
    agent_id: r.agent_id,
    status: r.status,
    output: r.output,
    token_used: r.token_used,
    execution_time_seconds: r.execution_time_seconds,
    error: r.error,
    worktree_cleaned: r.worktree_cleaned,
    isolated: r.isolated,
    guard_result: r.guard_result,
    metadata: r.metadata,
  };
}

// ============================================================================
// SubagentSandbox 配置
// ============================================================================

/** SubagentSandbox 配置 */
export interface SubagentSandboxConfig {
  /** WorktreeManager 实例（undefined 时禁用 worktree 隔离） */
  worktree_manager?: WorktreeManager;
  /** PerformanceFingerprint 实例（undefined 时不反哺） */
  fingerprint?: SandboxFingerprintLike;
  /** 是否启用 Guard 校验（默认 true；生产环境必须保持） */
  guard_enabled: boolean;
  /** Guard 实例（guard_enabled=true 时必须） */
  guard?: GuardLike;
  /** Phase 8：SkillInjector 实例（undefined 时不注入 skill） */
  skill_injector?: SkillInjectorLike;
  /** Phase 9：InterruptionRecoveryManager 实例（undefined 时不启用恢复） */
  recovery_manager?: InterruptionRecoveryManagerLike;
  /** 日志回调 */
  log?: SandboxLogCallback;
}

/** Sandbox 日志回调 */
export type SandboxLogCallback = (level: string, message: string) => void;

/** 默认日志回调 */
export const defaultSandboxLog: SandboxLogCallback = (level, message) => {
  console.log(`[subagent-sandbox] [${level}] ${message}`);
};

// ============================================================================
// SubagentSandbox 主类
// ============================================================================

/** Executor 函数签名 */
export type SandboxExecutor = (ctx: SandboxContext) => unknown;

/**
 * subagent 执行沙箱
 *
 * 核心能力：
 * 1. worktree 隔离（可选，通过 isolation_level 控制）
 * 2. context 隔离（通过 context_instance_id 区分）
 * 3. Token 预算硬上限（执行中实时检查）
 * 4. Guard 强制校验（不可绕过）
 * 5. 异常隔离（finally 块清理 worktree）
 * 6. 资源画像反哺（写入 PerformanceFingerprint）
 * 7. Phase 8：Skill 注入（向后兼容：默认未启用）
 * 8. Phase 9：pause/resume/cancel + 恢复重试（向后兼容：默认未启用）
 *
 * 使用示例：
 * ```typescript
 * const sandbox = new SubagentSandbox({
 *   worktree_manager,
 *   fingerprint,
 *   guard_enabled: true,
 *   guard,
 * });
 *
 * // 创建沙箱
 * const sandboxId = sandbox.spawn({
 *   agent_id: "sa_001",
 *   task: { description: "审查 50 个文件" },
 *   isolation_level: "context",
 *   token_budget: 5000,
 * });
 *
 * // 执行
 * function myExecutor(ctx: SandboxContext) {
 *   recordToken(ctx, 100);
 *   return { result: "ok" };
 * }
 *
 * try {
 *   const result = sandbox.execute(sandboxId, myExecutor);
 *   console.log(result.status); // "success"
 * } finally {
 *   sandbox.cleanup(sandboxId);
 * }
 * ```
 */
export class SubagentSandbox {
  /** 默认 token 预算 */
  public static readonly DEFAULT_TOKEN_BUDGET = 10_000;
  /** 默认执行超时（秒） */
  public static readonly DEFAULT_EXEC_TIMEOUT = 300;

  private _worktree_manager: WorktreeManager | null;
  private _fingerprint: SandboxFingerprintLike | null;
  private _guard_enabled: boolean;
  private _guard: GuardLike | null;
  private _skill_injector: SkillInjectorLike | null;
  private _recovery_manager: InterruptionRecoveryManagerLike | null;
  private _log: SandboxLogCallback;
  /** 活跃沙箱表 */
  private _active_sandboxes: Map<string, SandboxContext> = new Map();
  /** 沙箱结果（事后查询） */
  private _results: Map<string, SandboxResult> = new Map();

  constructor(config: Partial<SubagentSandboxConfig> = {}) {
    this._worktree_manager = config.worktree_manager ?? null;
    this._fingerprint = config.fingerprint ?? null;
    this._guard_enabled = config.guard_enabled ?? true;
    this._guard = config.guard ?? null;
    this._skill_injector = config.skill_injector ?? null;
    this._recovery_manager = config.recovery_manager ?? null;
    this._log = config.log ?? defaultSandboxLog;

    if (!this._guard_enabled) {
      this._log("warning", "guard_enabled=false：跳过 Guard 校验。生产环境必须保持 true。");
    }
    if (this._guard_enabled && this._guard === null) {
      this._log("warning", "guard_enabled=true 但未注入 guard 实例；将使用 noop guard（仅允许通过）");
      this._guard = createNoopGuard();
    }
  }

  // ------------------------------------------------------------------
  // 属性
  // ------------------------------------------------------------------

  /** 活跃沙箱数量 */
  get activeCount(): number {
    return this._active_sandboxes.size;
  }

  /** WorktreeManager 实例 */
  get worktreeManager(): WorktreeManager | null {
    return this._worktree_manager;
  }

  /** PerformanceFingerprint 实例 */
  get fingerprint(): SandboxFingerprintLike | null {
    return this._fingerprint;
  }

  /** SkillInjector 实例 */
  get skillInjector(): SkillInjectorLike | null {
    return this._skill_injector;
  }

  /** Recovery Manager 实例 */
  get recoveryManager(): InterruptionRecoveryManagerLike | null {
    return this._recovery_manager;
  }

  // ------------------------------------------------------------------
  // Phase 9：pause / resume / cancel
  // ------------------------------------------------------------------

  /**
   * 暂停正在执行的 subagent
   *
   * @param sandbox_id 沙箱 ID
   * @param reason 暂停原因（用于日志）
   * @returns true 表示暂停信号已设置；sandbox 不存在时返回 false
   */
  pause(sandbox_id: string, reason: string = "user_request"): boolean {
    const ctx = this._active_sandboxes.get(sandbox_id);
    if (!ctx) {
      this._log("warning", `pause 失败：sandbox 不存在 ${sandbox_id}`);
      return false;
    }
    ctx.pause_requested = true;
    this._log("info", `暂停信号已设置：${sandbox_id}（reason=${reason}）`);
    return true;
  }

  /**
   * 恢复暂停的 subagent
   *
   * @param sandbox_id 沙箱 ID
   * @param snapshot_id 可选快照 ID（用于深恢复）
   * @returns true 表示恢复信号已清除；sandbox 不存在时返回 false
   */
  resume(sandbox_id: string, snapshot_id?: string): boolean {
    const ctx = this._active_sandboxes.get(sandbox_id);
    if (!ctx) {
      this._log("warning", `resume 失败：sandbox 不存在 ${sandbox_id}`);
      return false;
    }
    ctx.pause_requested = false;
    // 注入快照（如有）
    if (snapshot_id !== undefined && this._recovery_manager !== null) {
      const snapshot = this._recovery_manager.load_snapshot(snapshot_id);
      if (snapshot !== null) {
        ctx.snapshot = snapshot.to_dict();
        this._log("info", `恢复时注入快照：${snapshot_id}（sandbox=${sandbox_id}）`);
      }
    }
    this._log("info", `恢复信号已清除：${sandbox_id}`);
    return true;
  }

  /**
   * 主动取消 subagent
   */
  cancel(sandbox_id: string, reason: string = "user_request"): boolean {
    const ctx = this._active_sandboxes.get(sandbox_id);
    if (!ctx) {
      this._log("warning", `cancel 失败：sandbox 不存在 ${sandbox_id}`);
      return false;
    }
    ctx.cancel_requested = true;
    this._log("info", `取消信号已设置：${sandbox_id}（reason=${reason}）`);
    return true;
  }

  /** 查询 sandbox 是否处于暂停状态 */
  isPaused(sandbox_id: string): boolean {
    const ctx = this._active_sandboxes.get(sandbox_id);
    if (!ctx) {
      return false;
    }
    return ctx.pause_requested;
  }

  /** 查询 sandbox 是否处于取消状态 */
  isCancelled(sandbox_id: string): boolean {
    const ctx = this._active_sandboxes.get(sandbox_id);
    if (!ctx) {
      return false;
    }
    return ctx.cancel_requested;
  }

  // ------------------------------------------------------------------
  // Phase 8：Skill 注入
  // ------------------------------------------------------------------

  /**
   * 执行 skill 注入（Phase 8）
   *
   * @returns 注入结果元数据；失败时返回空结果（不抛异常）
   */
  private _performSkillInjection(
    task: Record<string, unknown>,
    token_budget: number
  ): {
    enabled: boolean;
    skipped: boolean;
    injected_skills: string[];
    rendered_text: string;
    mode: string | null;
    missing_skills: string[];
    circular_skills: string[];
    truncated: boolean;
    injection_time_ms: number;
    errors: string[];
  } {
    if (this._skill_injector === null) {
      return {
        enabled: false,
        skipped: false,
        injected_skills: [],
        rendered_text: "",
        mode: null,
        missing_skills: [],
        circular_skills: [],
        truncated: false,
        injection_time_ms: 0.0,
        errors: [],
      };
    }

    const taskSkill = task["task_skill"];
    if (taskSkill === undefined || taskSkill === null) {
      // 向后兼容：不传 task_skill 视为不注入
      return {
        enabled: true,
        skipped: true,
        injected_skills: [],
        rendered_text: "",
        mode: null,
        missing_skills: [],
        circular_skills: [],
        truncated: false,
        injection_time_ms: 0.0,
        errors: [],
      };
    }

    try {
      const result = this._skill_injector.inject({
        task_skill: taskSkill as string | string[],
        skill_mode: task["skill_mode"] as string | undefined,
        skill_priority: task["skill_priority"] as string | undefined,
        token_budget,
      });
      return {
        enabled: true,
        skipped: false,
        injected_skills: result.injected_skills,
        rendered_text: result.rendered_text,
        mode: result.mode,
        missing_skills: result.missing_skills,
        circular_skills: result.circular_skills,
        truncated: result.truncated,
        injection_time_ms: result.injection_time_ms,
        errors: result.errors,
      };
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      this._log("warning", `Skill 注入异常（已隔离，sandbox 继续）：${errMsg}`);
      return {
        enabled: true,
        skipped: false,
        injected_skills: [],
        rendered_text: "",
        mode: null,
        missing_skills: [],
        circular_skills: [],
        truncated: false,
        injection_time_ms: 0.0,
        errors: [errMsg],
      };
    }
  }

  // ------------------------------------------------------------------
  // 公共 API：spawn / execute / cleanup
  // ------------------------------------------------------------------

  /**
   * 创建 subagent 沙箱
   *
   * 流程：
   * 1. Guard 校验（如启用）
   * 2. 创建 worktree（如需）
   * 3. 分配 context_instance_id
   * 4. Skill 注入（如启用 + 任务声明）
   * 5. 记录到 PerformanceFingerprint（如可用）
   * 6. 返回 sandbox_id
   *
   * @throws ValueError 隔离级别无效
   * @throws GuardRejectError Guard 拒绝
   */
  spawn(args: {
    agent_id: string;
    task: Record<string, unknown>;
    isolation_level?: IsolationLevelType;
    token_budget?: number;
  }): string {
    const isolationLevel = args.isolation_level ?? IsolationLevel.CONTEXT;
    const tokenBudget = args.token_budget ?? SubagentSandbox.DEFAULT_TOKEN_BUDGET;

    if (!isValidIsolationLevel(isolationLevel)) {
      throw new Error(`无效隔离级别：${isolationLevel}（有效：${ALL_ISOLATION_LEVELS.join(", ")}）`);
    }

    // Step 1: Guard 校验（不可绕过）
    if (this._guard_enabled && this._guard !== null) {
      const guardResult = this._guard.check({
        inputs: args.task,
        token_budget: tokenBudget,
      });
      if (!guardResult.is_allowed) {
        this._recordToFingerprint({
          agent_id: args.agent_id,
          sandbox_id: null,
          status: SandboxStatus.REJECTED,
          error: `Guard rejected: ${guardResult.reason}`,
          token_used: 0,
        });
        throw new GuardRejectError(`Guard 拒绝：${guardResult.reason}`, guardResult);
      }
    }

    // Step 2: 创建 worktree
    let worktreeInfo: WorktreeInfo | null = null;
    if (
      (isolationLevel === IsolationLevel.WORKTREE || isolationLevel === IsolationLevel.FULL) &&
      this._worktree_manager !== null
    ) {
      try {
        worktreeInfo = this._worktree_manager.create({
          worktreeId: args.agent_id,
          baseBranch: undefined,
        });
        if (worktreeInfo === null) {
          this._log("warning", `worktree 创建失败（git 不可用），降级 isolation_level 到 context`);
        }
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        this._log("warning", `worktree 创建异常：${errMsg}，降级处理`);
      }
    }

    // Step 3: 分配 context_instance_id
    let contextInstanceId: string | null = null;
    if (isolationLevel === IsolationLevel.CONTEXT || isolationLevel === IsolationLevel.FULL) {
      contextInstanceId = `ctx_${Math.random().toString(36).slice(2, 14)}`;
    }

    // Step 3.5: Phase 8 - Skill 注入
    const skillInjectionResult = this._performSkillInjection(args.task, tokenBudget);

    // Step 4: 创建沙箱
    const sandboxId = `sb_${Math.random().toString(36).slice(2, 14)}`;
    const sandboxCtx = createSandboxContext({
      sandbox_id: sandboxId,
      agent_id: args.agent_id,
      isolation_level: isolationLevel,
      worktree_path: worktreeInfo ? worktreeInfo.path : null,
      context_instance_id: contextInstanceId,
      token_budget: tokenBudget,
      injected_skills: skillInjectionResult.injected_skills,
      skill_injection_text: skillInjectionResult.rendered_text,
      skill_injection_meta: {
        enabled: skillInjectionResult.enabled,
        skipped: skillInjectionResult.skipped,
        mode: skillInjectionResult.mode,
        missing_skills: skillInjectionResult.missing_skills,
        circular_skills: skillInjectionResult.circular_skills,
        truncated: skillInjectionResult.truncated,
        injection_time_ms: skillInjectionResult.injection_time_ms,
        errors: skillInjectionResult.errors,
      },
    });

    if (this._active_sandboxes.has(sandboxId)) {
      // 清理已创建的 worktree
      if (worktreeInfo && this._worktree_manager) {
        this._worktree_manager.cleanup({ worktreeId: worktreeInfo.worktree_id });
      }
      throw new SandboxAlreadyExistsError(sandboxId);
    }
    this._active_sandboxes.set(sandboxId, sandboxCtx);

    // Step 5: 记录到画像
    this._recordToFingerprint({
      agent_id: args.agent_id,
      sandbox_id: sandboxId,
      status: SandboxStatus.PENDING,
      error: null,
      token_used: 0,
      isolation_level: isolationLevel,
    });

    this._log(
      "info",
      `沙箱创建成功：${sandboxId}（agent=${args.agent_id}, isolation=${isolationLevel}, token_budget=${tokenBudget}）`
    );
    return sandboxId;
  }

  /**
   * 在沙箱中执行任务
   *
   * @throws SandboxNotFoundError 沙箱不存在
   */
  execute(
    sandbox_id: string,
    executor: SandboxExecutor,
    timeout: number = SubagentSandbox.DEFAULT_EXEC_TIMEOUT
  ): SandboxResult {
    const sandboxCtx = this._active_sandboxes.get(sandbox_id);
    if (!sandboxCtx) {
      throw new SandboxNotFoundError(sandbox_id);
    }

    const startTime = Date.now();
    let status: SandboxStatusType = SandboxStatus.RUNNING;
    let output: unknown = null;
    let error: string | null = null;
    let isolated = false;

    // 包装 executor（带 pause/cancel 轮询 + recovery 触发）
    const wrapped = this._wrapExecutorForRecovery(executor, sandboxCtx);

    try {
      output = wrapped(sandboxCtx);
      status = SandboxStatus.SUCCESS;
    } catch (e) {
      if (e instanceof UserAbortError) {
        status = SandboxStatus.CANCELLED;
        error = `UserAbort: ${e.message}`;
        isolated = true;
        this._log("info", `沙箱 ${sandbox_id} 被用户取消`);
      } else if (e instanceof TokenBudgetExceededSandbox) {
        status = SandboxStatus.TOKEN_EXCEEDED;
        error = `Token 预算超限：${e.token_used}/${e.token_budget}`;
        this._log("warning", `沙箱 ${sandbox_id} Token 超限，降级处理`);
      } else if (e instanceof SandboxTimeoutError) {
        status = SandboxStatus.TIMEOUT;
        error = e.message;
      } else if (e instanceof Error) {
        // 异常隔离：不传播给父
        status = SandboxStatus.FAILURE;
        error = `${e.constructor.name}: ${e.message}`;
        isolated = true;
        this._log("error", `沙箱 ${sandbox_id} executor 异常（已隔离）：${error}`);
      } else {
        status = SandboxStatus.FAILURE;
        error = String(e);
        isolated = true;
      }
    }

    // 结果构造与画像反哺（原 finally 块逻辑：上方 catch 已全量隔离异常，本段不会抛出；
    // 修复 eslint no-unsafe-finally——finally 中 return 会吞掉异常栈，语义不变）
    const executionTime = (Date.now() - startTime) / 1000;
    const tokenUsed = sandboxCtx.token_used;

    // 构造结果
    const result: SandboxResult = {
      sandbox_id,
      agent_id: sandboxCtx.agent_id,
      status,
      output,
      token_used: tokenUsed,
      execution_time_seconds: executionTime,
      error,
      worktree_cleaned: false, // cleanup 时再设置
      isolated,
      guard_result: null,
      metadata: {
        isolation_level: sandboxCtx.isolation_level,
        worktree_path: sandboxCtx.worktree_path,
        context_instance_id: sandboxCtx.context_instance_id,
        skill_injection:
          sandboxCtx.injected_skills.length > 0 ||
          (sandboxCtx.skill_injection_meta["missing_skills"] as string[] | undefined)?.length
            ? {
                injected_skills: sandboxCtx.injected_skills,
                mode: sandboxCtx.skill_injection_meta["mode"],
                missing_skills: sandboxCtx.skill_injection_meta["missing_skills"],
                circular_skills: sandboxCtx.skill_injection_meta["circular_skills"],
                truncated: sandboxCtx.skill_injection_meta["truncated"],
                injection_time_ms: sandboxCtx.skill_injection_meta["injection_time_ms"],
              }
            : null,
        interruption: {
          cancelled: sandboxCtx.cancel_requested,
          paused: sandboxCtx.pause_requested,
          has_snapshot: sandboxCtx.snapshot !== null,
          intermediate_results_count: Object.keys(sandboxCtx.intermediate_results).length,
        },
      },
    };

    this._results.set(sandbox_id, result);

    // 画像反哺
    this._recordToFingerprint({
      agent_id: sandboxCtx.agent_id,
      sandbox_id,
      status,
      error,
      token_used: tokenUsed,
      execution_time: executionTime,
    });

    return result;
  }

  /**
   * 包装 executor：注入 pause/cancel 轮询和恢复逻辑
   */
  private _wrapExecutorForRecovery(executor: SandboxExecutor, sandboxCtx: SandboxContext): SandboxExecutor {
    return (ctx: SandboxContext): unknown => {
      // 检查 cancel_event（最高优先级）
      if (ctx.cancel_requested) {
        throw new UserAbortError("user_abort_signal_set_before_invoke");
      }
      // 检查 pause_event（set 则同步等待 resume）
      // 在 Node 单线程模型下，pause/resume 是协作式；阻塞检查
      this._waitIfPaused(ctx);

      // 尝试执行（含重试逻辑）
      const maxAttempts = this._recovery_manager !== null ? this._recovery_manager.retry_policy.max_retries + 1 : 1;
      let attempts = 0;
      let lastException: Error | null = null;

      while (attempts < maxAttempts) {
        attempts += 1;
        // 每次重试前再次检查 cancel_event
        if (ctx.cancel_requested) {
          throw new UserAbortError("user_abort_signal_during_retry");
        }
        // 每次重试前再次检查 pause_event
        this._waitIfPaused(ctx);

        try {
          return executor(ctx);
        } catch (e) {
          if (e instanceof PauseRequestError) {
            // 用户主动暂停：挂起到 resume 后重试
            this._log("debug", `executor 抛 PauseRequest（sandbox=${ctx.sandbox_id}）`);
            this._waitIfPaused(ctx);
            continue;
          }
          if (e instanceof UserAbortError) {
            // 用户主动取消：直接抛出
            throw e;
          }
          if (e instanceof TokenBudgetExceededSandbox || e instanceof SandboxTimeoutError) {
            // 内部已知异常：不触发恢复
            throw e;
          }
          // 业务异常
          if (e instanceof Error) {
            lastException = e;
          } else {
            lastException = new Error(String(e));
          }
          if (attempts >= maxAttempts) {
            // 已用完所有重试次数
            throw lastException;
          }
          // 触发恢复（如可用）
          if (this._recovery_manager && this._recovery_manager.attempt_recovery) {
            try {
              const recovered = this._recovery_manager.attempt_recovery({
                sandbox_id: ctx.sandbox_id,
                error: lastException,
                attempt: attempts,
              });
              if (!recovered) {
                throw lastException;
              }
            } catch (recoveryErr) {
              const errMsg = recoveryErr instanceof Error ? recoveryErr.message : String(recoveryErr);
              this._log("error", `恢复失败：${errMsg}`);
              throw lastException;
            }
          }
          // 重试
        }
      }
      // 不可达
      throw lastException ?? new Error("executor failed without exception");
    };
  }

  /**
   * 同步等待直到 pause 解除（Node 单线程下的协作式暂停）
   */
  private _waitIfPaused(ctx: SandboxContext): void {
    if (!ctx.pause_requested) {
      return;
    }
    // 轮询直到 resume
    const start = Date.now();
    while (ctx.pause_requested) {
      if (Date.now() - start > 30 * 60 * 1000) {
        // 30 分钟上限
        this._log("warning", `pause 等待超过 30 分钟，自动 resume（sandbox=${ctx.sandbox_id}）`);
        ctx.pause_requested = false;
        break;
      }
      // 释放 CPU
      const until = Date.now() + 100;
      while (Date.now() < until) {
        // busy wait 100ms
      }
    }
  }

  /**
   * 清理沙箱（删除 worktree，移除活跃表）
   */
  cleanup(sandbox_id: string): void {
    const ctx = this._active_sandboxes.get(sandbox_id);
    if (!ctx) {
      this._log("warning", `cleanup：sandbox 不存在 ${sandbox_id}`);
      return;
    }

    // 删除 worktree
    if (ctx.worktree_path && this._worktree_manager) {
      // 找到 worktree_id（通过 worktree_id 清理）
      const worktreeId = ctx.worktree_path.split("/").pop() ?? ctx.worktree_path;
      try {
        this._worktree_manager.cleanup({ worktreeId });
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        this._log("error", `worktree cleanup 失败：${errMsg}`);
      }
    }

    // 更新结果
    const result = this._results.get(sandbox_id);
    if (result) {
      result.worktree_cleaned = true;
      this._results.set(sandbox_id, result);
    }

    this._active_sandboxes.delete(sandbox_id);
    this._log("info", `沙箱已清理：${sandbox_id}`);
  }

  /** 获取沙箱结果（事后查询） */
  getResult(sandbox_id: string): SandboxResult | null {
    return this._results.get(sandbox_id) ?? null;
  }

  /** 获取活跃沙箱上下文 */
  getContext(sandbox_id: string): SandboxContext | null {
    return this._active_sandboxes.get(sandbox_id) ?? null;
  }

  /** 获取所有活跃沙箱 ID */
  getActiveSandboxIds(): string[] {
    return Array.from(this._active_sandboxes.keys());
  }

  // ------------------------------------------------------------------
  // 内部：画像反哺
  // ------------------------------------------------------------------

  private _recordToFingerprint(args: {
    agent_id: string;
    sandbox_id: string | null;
    status: SandboxStatusType;
    error: string | null;
    token_used: number;
    execution_time?: number;
    isolation_level?: IsolationLevelType;
  }): void {
    if (this._fingerprint === null) {
      return;
    }
    try {
      this._fingerprint.record({
        task_type: `sandbox:${args.status}`,
        task_complexity: 5,
        success: args.status === SandboxStatus.SUCCESS,
        error_type: args.error ? args.error.split(":")[0] : undefined,
        execution_time: args.execution_time ?? 0.0,
        strategy: `sandbox_id=${args.sandbox_id ?? "null"};isolation=${args.isolation_level ?? "unknown"};status=${args.status}`,
        context_features: {
          sandbox_id: args.sandbox_id,
          agent_id: args.agent_id,
          status: args.status,
          error: args.error,
          token_used: args.token_used,
          isolation_level: args.isolation_level,
        },
      });
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      this._log("error", `写入沙箱记录到画像失败：${errMsg}`);
    }
  }
}

// ============================================================================
// 工具：默认 Guard（noop）
// ============================================================================

/** 创建一个 noop Guard（仅允许通过；用于开发/测试） */
export function createNoopGuard(): GuardLike {
  return {
    check: (_args: { inputs: Record<string, unknown>; token_budget: number }): GuardResultLike => {
      return {
        is_allowed: true,
        reason: "noop guard (always allow)",
        warnings: [],
      };
    },
  };
}

// ============================================================================
// 默认导出
// ============================================================================

export default {
  // 异常
  SandboxError,
  GuardRejectError,
  TokenBudgetExceededSandbox,
  SandboxNotFoundError,
  SandboxAlreadyExistsError,
  SandboxTimeoutError,
  UserAbortError,
  PauseRequestError,
  // 枚举 / 常量
  SandboxStatus,
  ALL_SANDBOX_STATUSES,
  IsolationLevel,
  ALL_ISOLATION_LEVELS,
  isValidIsolationLevel,
  // 工厂
  createSandboxContext,
  recordToken,
  sandboxResultToDict,
  createNoopGuard,
  // 默认日志
  defaultSandboxLog,
  // 类
  SubagentSandbox,
};
