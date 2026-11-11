/**
 * Loop Guard —— 共享上限保护模块
 *
 * EAG 方案 §5.2.1 评审 A-3/A-4 共识：eag/loop 与 team/autonomous/loop-controller
 * 两套循环的上限保护/退避策略提取为共享模块，避免第三套循环方言。
 *
 * 功能：
 * 1. max_iterations 上限保护（防止无限循环）
 * 2. max_tokens 预算守门（防止 Token 爆炸）
 * 3. 连续失败 abort（连续 N 次 FIX 失败终止 Loop）
 * 4. 指数退避 + jitter（失败后重试的时间间隔策略）
 *
 * 设计依据：
 * - EAG 方案 §5.2.1 五步闭环上限保护
 * - EAG 方案 §5.12.3 AU-5 硬上限已配置（LLM 在循环内不可自改上限）
 * - multi-agent-team skill scripts/autonomous/loop_controller.py 退避策略
 *
 * jev 集成（2026-11-10，docs/dev/jev-loop-decision-20261110.md）：
 * 5. jev 主判路径 evaluateJevDecision——循环是否继续/空循环判定交由
 *    NeoHorse-Jev-4B 远程决策模型；硬编码阈值降级为 heuristic 兜底路径
 *    （jev 不可达/超时/连续异常时启用），详见 jev-loop-decision.ts。
 *
 * @module common/loop-guard
 */

import type { JevAnswer } from "./jev-client";
import { readChoiceAnswer } from "./jev-loop-decision";

// ============================================================================
// 类型定义
// ============================================================================

/**
 * Loop Guard 配置
 *
 * 定义循环的上限保护参数。配置对象在创建后应被 Object.freeze 冻结，
 * 确保 LLM 在循环内不可自改上限（§5.12.3 AU-5 / §5.12.4 G-A6d）。
 */
export interface LoopGuardConfig {
  /** 最大迭代次数（默认 50，上限 1000） */
  maxIterations: number;
  /** 最大 Token 预算（默认 200000，约 GPT-4 上下文窗口的 50%） */
  maxTokens: number;
  /** 连续失败上限（默认 3，§5.2.3 连续 3 次同类失败 → HUMAN_CHECKPOINT） */
  maxConsecutiveFailures: number;
  /** 初始退避延迟（毫秒，默认 1000） */
  initialBackoffMs: number;
  /** 最大退避延迟（毫秒，默认 30000，即 30 秒） */
  maxBackoffMs: number;
  /** 退避乘数（每次失败延迟乘以此系数，默认 2.0 指数退避） */
  backoffMultiplier: number;
  /** Jitter 比例（0-1，默认 0.1，即 ±10% 随机抖动避免惊群） */
  jitterRatio: number;
}

/**
 * Loop Guard 运行时状态
 *
 * 跟踪循环的实时消耗，用于判定是否触达上限。
 */
export interface LoopGuardState {
  /** 已执行迭代次数 */
  iterationsCompleted: number;
  /** 已消耗 Token 数 */
  tokensConsumed: number;
  /** 当前连续失败次数 */
  consecutiveFailures: number;
  /** 总失败次数（含非连续的） */
  totalFailures: number;
  /** 上次失败时间（ISO 8601，用于退避计算） */
  lastFailureTime?: string;
  /** 当前退避级别（第 N 次失败，用于指数退避计算） */
  backoffLevel: number;
}

/**
 * Guard 检查结果
 *
 * 每次迭代前调用 check() 获取当前是否允许继续执行。
 */
export interface GuardCheckResult {
  /** 是否允许继续执行 */
  allowed: boolean;
  /** 终止原因（allowed=false 时填写） */
  stopReason?: GuardStopReason;
  /** 建议的等待时间（毫秒，用于退避，allowed=true 且有失败记录时填写） */
  suggestedWaitMs?: number;
  /** 当前状态快照 */
  state: LoopGuardState;
  /** 剩余迭代次数 */
  remainingIterations: number;
  /** 剩余 Token 预算 */
  remainingTokens: number;
}

/**
 * Guard 终止原因
 */
export type GuardStopReason =
  | "max_iterations_exceeded"
  | "max_tokens_exceeded"
  | "max_consecutive_failures"
  | "manually_aborted";

// ============================================================================
// 需求123/124：普通会话循环护栏配置（2026-10-17）
// ============================================================================

/**
 * 普通会话（交互式 chat）循环护栏配置
 *
 * 与 EAG 场景的 LoopGuardConfig 分离：EAG 场景触达上限直接终止；
 * 普通会话连续失败时暂停并咨询用户（需求124 预期：
 * "反复处理无果后（同一请求拨通3-5次），咨询用户是否继续"）。
 *
 * Token 预算护栏已移除（2026-10-19 需求变更）：
 * 上下文压力改由"自动压缩 + 新任务切新上下文"策略接管——
 * - 上下文不足（activeTokens 超阈值）→ 自动 compactSession（session.ts 主循环既有逻辑）
 * - 新任务（LLM 意图分类判定）→ 归档旧上下文直接切换（replySession 入口）
 * 因此 TurnGuard 不再设置 Token 硬终止线，tokensConsumed 仅作状态观测保留。
 *
 * 迭代轮数上限已移除（2026-10-20 需求变更"去掉 40 轮限制"）：
 * 原优先级 3 的 consult_user_max_turns（40 轮未解决即暂停咨询）删除——
 * 迭代轮数不再触发咨询/终止，长任务可一直执行；防失控由模型循环检测
 * （同工具+参数重复调用 → 硬终止）与连续工具全失败咨询兜底。
 * turnsCompleted 仍每轮累计（观测口径），acknowledgeAndContinue 同步清零。
 *
 * 模型循环检测（2026-10-19 新增）：
 * 跟踪最近 N 次 tool 调用签名（tool name + 简化参数 hash），
 * 当连续 maxRepeatedToolCalls 次调用相同工具 + 相同参数 → 自动终止，
 * 防止模型陷入"同一命令反复重试"的死循环烧 Token。
 */
export interface TurnGuardConfig {
  /** 连续工具全失败轮数上限（默认 3，需求124"同一请求拨通3-5次"下限） */
  maxConsecutiveFailedTurns: number;
  /**
   * 循环检测：连续多少次调用相同工具+相同参数即判定为模型死循环（默认 3）。
   * 设为 0 禁用循环检测。
   */
  maxRepeatedToolCalls: number;
  /**
   * 循环检测：跟踪最近多少次 tool 调用的签名（默认 5）。
   * 越大检测越准但内存开销略增。
   */
  trackedToolCallHistory: number;
  /**
   * 连续"空转轮"暂停咨询上限（默认 5，2026-10-23 空循环修复新增）。
   * 设为 0 禁用空转检测。
   *
   * 空转轮定义：本轮 LLM 响应**可见正文为空**（content 去空白后为空串）**且**
   * 本轮没有任何工具执行成功——模型既没说人话也没干活，纯粹在烧轮次。
   *
   * 事故复盘（会话 b14ab3e1，2026-10-22）：qwen3.8-flash 在"检查文档修复情况并
   * 页面测试"任务中连续多轮仅输出 "\n\n\n"（信息全在 reasoning 里），且既有
   * 两条护栏全部失效——模型循环检测要求**相同**工具+参数（模型每轮换命令），
   * 连续失败咨询要求工具**全部**失败（工具其实都成功）。轮数上限与 Token 线
   * 已按 2026-10-20 需求移除，空转成为护栏盲区，本判定补位。
   */
  maxConsecutiveEmptyTurns: number;
}

/**
 * 每个预算窗口内空轮 nudge 注入硬上限（校准计划阶段 C）。
 * 防 nudge 重试风暴：达上限后空轮治理交还既有「连续空转 → consult」路径。
 */
export const MAX_NUDGES_PER_WINDOW = 3;

/**
 * 默认循环护栏配置（需求124 + 2026-10-19 模型循环检测 + 2026-10-20 轮数上限移除）
 *
 * 数值依据：
 * - maxConsecutiveFailedTurns=3：需求124 下限——连续 3 轮工具调用全部失败
 *   即判定"反复处理无果"，暂停咨询
 * - maxRepeatedToolCalls=3：同一工具 + 相同参数连续调用 3 次 → 模型死循环
 * - trackedToolCallHistory=5：跟踪最近 5 次 tool 调用签名
 */
export const DEFAULT_TURN_GUARD_CONFIG: Readonly<TurnGuardConfig> = Object.freeze({
  maxConsecutiveFailedTurns: 3,
  maxRepeatedToolCalls: 3,
  trackedToolCallHistory: 5,
  maxConsecutiveEmptyTurns: 5,
});

// 注：maxConsecutiveEmptyTurns=5（2026-10-23 空转护栏）——比连续失败咨询（3）
// 宽松两档：空转轮允许工具在推进（换命令试探），连续 5 轮"空文本且无工具
// 成功"才咨询；0 表示禁用。

/**
 * 循环护栏触发的暂停动作类型（需求124 + 2026-10-19 模型循环检测 + 2026-11-10 jev）
 */
export type LoopGuardAction =
  /** 连续工具全失败达上限 → 暂停咨询用户（可恢复） */
  | "consult_user_consecutive_failures"
  /** 模型死循环（同一工具+参数重复调用）→ 直接终止（不可恢复） */
  | "terminate_model_loop"
  /** 连续空转轮（空文本且无工具成功）达上限 → 暂停咨询用户（可恢复，2026-10-23） */
  | "consult_user_empty_turns"
  /**
   * 循环判定模块要求停止 → 暂停咨询用户（可恢复，2026-11-10 jev 重构）。
   * 覆盖两种来源：① jev 模型 stop 判定（主判路径）；② jev 降级首轮的
   * heuristic 疑似死循环降级（架构师审查 P0-1：禁硬终止）。终止权保留给
   * 用户，暂停咨询后由用户决定去留。
   */
  | "consult_user_loop_stop";

/**
 * 循环护栏判定结果（需求123/124）
 */
export interface LoopGuardTurnDecision {
  /** 是否允许本轮迭代继续执行 */
  allow: boolean;
  /** 触发动作（allow=false 时必填） */
  action?: LoopGuardAction;
  /** 人类可读的暂停/终止原因（供注入 system 消息或通知用户） */
  reason: string;
}

// ============================================================================
// 默认配置
// ============================================================================

/**
 * 默认 Loop Guard 配置
 *
 * 数值依据：
 * - maxIterations=50：覆盖大多数企业任务的迭代需求（autonomous 上限 1000）
 * - maxTokens=200000：约 GPT-4 上下文窗口的 50%，留余量给系统 prompt
 * - maxConsecutiveFailures=3：§5.2.3 连续 3 次同类失败 → HUMAN_CHECKPOINT
 * - initialBackoffMs=1000：首次失败后等待 1 秒
 * - maxBackoffMs=30000：退避上限 30 秒，避免过长等待
 * - backoffMultiplier=2.0：标准指数退避
 * - jitterRatio=0.1：±10% 随机抖动
 */
export const DEFAULT_LOOP_GUARD_CONFIG: Readonly<LoopGuardConfig> = Object.freeze({
  maxIterations: 50,
  maxTokens: 200_000,
  maxConsecutiveFailures: 3,
  initialBackoffMs: 1_000,
  maxBackoffMs: 30_000,
  backoffMultiplier: 2.0,
  jitterRatio: 0.1,
});

/**
 * 初始状态
 */
export const INITIAL_LOOP_GUARD_STATE: Readonly<LoopGuardState> = Object.freeze({
  iterationsCompleted: 0,
  tokensConsumed: 0,
  consecutiveFailures: 0,
  totalFailures: 0,
  backoffLevel: 0,
});

// ============================================================================
// LoopGuard 类
// ============================================================================

/**
 * Loop Guard 共享上限保护器
 *
 * 用法：
 * ```typescript
 * const guard = new LoopGuard({ maxIterations: 30, maxTokens: 100_000 });
 * while (true) {
 *   const check = guard.check();
 *   if (!check.allowed) {
 *     console.log(`Loop 终止：${check.stopReason}`);
 *     break;
 *   }
 *   if (check.suggestedWaitMs) {
 *     await sleep(check.suggestedWaitMs);
 *   }
 *   // 执行迭代...
 *   guard.recordIteration(tokensUsed, success);
 * }
 * ```
 *
 * 配置冻结保证（§5.12.4 G-A6d）：
 * - 构造函数接收配置后 Object.freeze 冻结，运行期不可修改
 * - maxIterations/maxTokens/maxConsecutiveFailures 对 LLM 只读
 * - 配置变更需退出 Loop 后重新构造 LoopGuard
 */
export class LoopGuard {
  /** 冻结的配置（运行期不可变） */
  private readonly config: Readonly<LoopGuardConfig>;
  /** 运行时状态（可变） */
  private state: LoopGuardState;
  /** 手动终止标志 */
  private manuallyAborted: boolean = false;
  /**
   * Token 预算是否**显式**配置（2026-11-01 修复"隐式卡预算"）。
   *
   * 背景：2026-10-20 需求变更后，Token 预算不再作为硬终止条件（防失控改由
   * 模型循环/空循环熔断 + 轮数上限承担），但本类的 maxTokens 仍默认取
   * DEFAULT_LOOP_GUARD_CONFIG 的 200_000 并硬终止。EAG/team 调用方只传
   * `{ maxIterations: 10 }` 时，会隐式继承 200k 上限 → 长任务在预算耗尽时
   * 被静默终止（典型"卡预算导致任务不执行"）。
   *
   * 语义对齐：仅当调用方**显式**传入正数 maxTokens 时才把 Token 当作硬终止，
   * 与 GraphGuard 的 `maxTokens=0 表示不限制` 约定一致；未显式配置时
   * remainingTokens 仍按默认值计算（保持观测口径），但不触发终止。
   */
  private readonly tokenBudgetEnforced: boolean;

  /**
   * 构造 LoopGuard
   *
   * @param config 配置（缺省字段使用 DEFAULT_LOOP_GUARD_CONFIG）
   */
  constructor(config?: Partial<LoopGuardConfig>) {
    this.config = Object.freeze({
      ...DEFAULT_LOOP_GUARD_CONFIG,
      ...config,
    });
    this.tokenBudgetEnforced =
      typeof config?.maxTokens === "number" && Number.isFinite(config.maxTokens) && config.maxTokens > 0;
    this.state = { ...INITIAL_LOOP_GUARD_STATE };
  }

  /**
   * 检查是否允许继续执行
   *
   * 每次迭代前调用，返回当前状态和是否允许继续。
   *
   * 终止条件（按优先级）：
   * 1. 手动终止（manuallyAborted=true）
   * 2. 连续失败超上限（consecutiveFailures >= maxConsecutiveFailures）
   * 3. 迭代次数超上限（iterationsCompleted >= maxIterations）
   * 4. Token 预算耗尽（**仅当调用方显式配置 maxTokens>0 时**：tokensConsumed >= maxTokens）
   *
   * @returns 检查结果
   */
  check(): GuardCheckResult {
    const remainingIterations = Math.max(0, this.config.maxIterations - this.state.iterationsCompleted);
    const remainingTokens = Math.max(0, this.config.maxTokens - this.state.tokensConsumed);

    // 1. 手动终止
    if (this.manuallyAborted) {
      return {
        allowed: false,
        stopReason: "manually_aborted",
        state: { ...this.state },
        remainingIterations,
        remainingTokens,
      };
    }

    // 2. 连续失败超上限
    if (this.state.consecutiveFailures >= this.config.maxConsecutiveFailures) {
      return {
        allowed: false,
        stopReason: "max_consecutive_failures",
        state: { ...this.state },
        remainingIterations,
        remainingTokens,
      };
    }

    // 3. 迭代次数超上限
    if (this.state.iterationsCompleted >= this.config.maxIterations) {
      return {
        allowed: false,
        stopReason: "max_iterations_exceeded",
        state: { ...this.state },
        remainingIterations,
        remainingTokens,
      };
    }

    // 4. Token 预算耗尽（仅显式配置时生效，见 tokenBudgetEnforced 注释）
    if (this.tokenBudgetEnforced && this.state.tokensConsumed >= this.config.maxTokens) {
      return {
        allowed: false,
        stopReason: "max_tokens_exceeded",
        state: { ...this.state },
        remainingIterations,
        remainingTokens,
      };
    }

    // 允许继续——计算退避建议（有失败记录时）
    const suggestedWaitMs = this.calculateBackoff();
    return {
      allowed: true,
      suggestedWaitMs: suggestedWaitMs > 0 ? suggestedWaitMs : undefined,
      state: { ...this.state },
      remainingIterations,
      remainingTokens,
    };
  }

  /**
   * 记录一次迭代完成
   *
   * 每次迭代结束后调用，更新消耗计数。
   *
   * @param tokensUsed 本次迭代消耗的 Token 数
   * @param success 本次迭代是否成功（评估器 verdict=pass）
   */
  recordIteration(tokensUsed: number, success: boolean): void {
    this.state.iterationsCompleted++;
    this.state.tokensConsumed += tokensUsed;
    if (success) {
      // 成功——重置连续失败计数
      this.state.consecutiveFailures = 0;
      this.state.backoffLevel = 0;
    } else {
      // 失败——递增失败计数
      this.state.consecutiveFailures++;
      this.state.totalFailures++;
      this.state.lastFailureTime = new Date().toISOString();
      this.state.backoffLevel++;
    }
  }

  /**
   * 手动终止
   *
   * 对外暴露的终止接口，供 /eag-autonomous --stop 调用（§5.12.4 G-A6b）。
   */
  abort(): void {
    this.manuallyAborted = true;
  }

  /**
   * 用户确认后重置连续失败计数（需求123/124 修复）
   *
   * 场景：普通会话执行中连续 N 次工具失败，Guard 判定 max_consecutive_failures
   * 暂停后向用户提问"是否继续"。用户选择继续时调用本方法：
   * - 连续失败计数清零（保留 totalFailures 总量，审计可追溯）
   * - 退避级别清零（避免继续后立即再次触发退避）
   *
   * 注意：不重置 iterationsCompleted / tokensConsumed——总预算约束不因
   * 用户放行而放宽，仅解除"连续失败熔断"这一条熔断线。
   */
  acknowledgeUserContinuation(): void {
    this.state.consecutiveFailures = 0;
    this.state.backoffLevel = 0;
  }

  /**
   * 获取当前状态快照（只读）
   */
  getState(): Readonly<LoopGuardState> {
    return { ...this.state };
  }

  /**
   * 获取配置（只读，冻结）
   */
  getConfig(): Readonly<LoopGuardConfig> {
    return this.config;
  }

  /**
   * 计算退避等待时间
   *
   * 指数退避 + jitter 策略：
   * - 基础延迟 = initialBackoffMs * (backoffMultiplier ^ backoffLevel)
   * - 上限截断 = min(baseDelay, maxBackoffMs)
   * - Jitter = baseDelay * jitterRatio * (random * 2 - 1)  // ±jitterRatio 范围
   * - 最终延迟 = max(0, truncated + jitter)
   *
   * @returns 建议等待毫秒数（0 表示无需等待）
   */
  private calculateBackoff(): number {
    if (this.state.backoffLevel === 0) {
      return 0; // 无失败记录，无需等待
    }

    // 指数退避基础延迟
    const baseDelay =
      this.config.initialBackoffMs * Math.pow(this.config.backoffMultiplier, this.state.backoffLevel - 1);

    // 上限截断
    const truncatedDelay = Math.min(baseDelay, this.config.maxBackoffMs);

    // Jitter（±jitterRatio 范围的随机抖动）
    const jitterRange = truncatedDelay * this.config.jitterRatio;
    const jitter = jitterRange * (Math.random() * 2 - 1);

    return Math.max(0, Math.round(truncatedDelay + jitter));
  }
}

// ============================================================================
// 工具结果签名（2026-11-10 死循环误杀修复）
// ============================================================================

/**
 * 计算工具结果的稳定签名（死循环检测的「结果维度」输入）
 *
 * 2026-11-10 修复：死循环检测原本只看「工具名+参数」，不看执行结果——对有状态
 * 命令（轮询等待服务就绪、tail 进度、重试直到成功）是误杀：重复同一命令但输出
 * /状态确实在变化是合法行为。修复后：结果签名也相同时才计入死循环；结果变化时
 * 签名自然不同、尾部连续性被打断，不会终止。
 *
 * 规范化口径与 eag/p5/executors/llm-task-executor.ts 的 normalizeResultContent
 * 对齐：剥离 bash 结果 JSON 中每轮必变的元数据（deadlineAt / cwd / timeoutMs 等），
 * 避免「元数据时间戳变化」把真实重复的结果误判成「结果变化」；非 JSON 文本退化为
 * 剥离 ISO 时间戳与 macOS /private 前缀。最终取长度 + 首尾各 64 字符的紧凑签名。
 *
 * @param content 工具执行的原始回执内容（formatToolResult 产物）
 * @returns 稳定签名字符串
 */
export function toolResultSignature(content: string): string {
  let normalized = content;
  try {
    const parsed = JSON.parse(content) as { metadata?: Record<string, unknown> };
    if (parsed.metadata !== null && typeof parsed.metadata === "object") {
      for (const key of ["deadlineAt", "cwd", "startCwd", "shellPath", "timeoutMs"]) {
        delete parsed.metadata[key];
      }
    }
    normalized = JSON.stringify(parsed);
  } catch {
    // 非 JSON 结果：文本级中性化，剥离绝对时间戳与 macOS /private 路径前缀
    normalized = content
      .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, "<ts>")
      .replace(/\/private(?=\/)/g, "");
  }
  return normalized.length > 128
    ? `${normalized.length}#${normalized.slice(0, 64)}#${normalized.slice(-64)}`
    : normalized;
}

// ============================================================================
// TurnGuard：普通会话循环护栏（需求123/124，2026-10-17）
// ============================================================================

/**
 * 普通会话循环护栏
 *
 * 解决的问题（需求123/124）：
 * - 需求123：复杂任务执行陷入死循环，40 轮内无法解决时终端无输出、进程异常关闭
 * - 需求124：反复重试直到 Token 耗尽（dev 阶段 41 次 LLM 请求）会话异常退出
 *
 * 与 LoopGuard（EAG 场景）的差异：
 * - LoopGuard：触达上限直接终止（自主长程任务无人值守）
 * - TurnGuard：触达轮数/连续失败上限时**暂停咨询用户**（交互式会话有人值守），
 *   用户确认后 acknowledgeAndContinue() 清零本轮计数继续执行；
 *   Token 预算硬终止线已移除（2026-10-19）——上下文压力由
 *   "自动压缩 + 新任务切新上下文"策略接管，tokensConsumed 仅作状态观测
 *
 * 用法（session.ts activateSession 主循环）：
 * ```typescript
 * const guard = new TurnGuard();               // 每 turn 新建，跨 turn 不累计
 * for (let iteration = 0; ; iteration++) {
 *   const decision = guard.decideBeforeIteration();
 *   if (!decision.allow) { ...咨询用户/终止... }
 *   // LLM 调用 + 工具执行
 *   guard.recordTurn({ tokensUsed, allToolsFailed, hadToolCalls });
 * }
 * // 用户确认继续：
 * guard.acknowledgeAndContinue();
 * ```
 *
 * 配置冻结保证同 LoopGuard（§5.12.4 G-A6d）：LLM 在循环内不可自改上限。
 */
export class TurnGuard {
  /** 冻结的配置（运行期不可变） */
  private readonly config: Readonly<TurnGuardConfig>;
  /** 本 turn 已完成的 LLM 迭代轮数 */
  private turnsCompleted = 0;
  /** 本 turn 累计消耗 Token（所有 LLM 请求的 total_tokens 之和） */
  private tokensConsumed = 0;
  /** 连续"工具调用全部失败"的轮数（任一轮有成功工具即清零） */
  private consecutiveFailedTurns = 0;
  /**
   * 连续"空转轮"计数（2026-10-23 空转护栏）：本轮可见正文为空且无任何工具
   * 执行成功 → +1；出现可见正文或任一工具成功 → 清零。
   */
  private consecutiveEmptyTurns = 0;

  /**
   * 最近 N 次 tool 调用签名队列（2026-10-19 新增，模型循环检测）。
   * 每个签名是 `toolName + "|" + argsHash` 的字符串。
   * 当队列尾部连续 maxRepeatedToolCalls 条签名相同 → 判定为死循环。
   */
  private readonly toolCallSignatures: string[] = [];

  /**
   * jev 主判模式开关（2026-11-10 jev 重构）。
   *
   * true = 循环判定主责由 jev 模型承担（evaluateJevDecision 决定去留），
   * 硬编码阈值**不参与**判定（decideBeforeIteration 仅作为 heuristic 兜底路径，
   * 由调用方在 jev 不可用时显式切换后调用）。
   * false = heuristic 硬兜底（既有行为）。
   */
  private jevPrimary = false;

  /**
   * 降级首轮禁硬终止标志（架构师审查 P0-1）。
   *
   * jev → heuristic 切换瞬间，硬阈值计数已由 acknowledgeAndContinue 清零，
   * 但 recordToolCalls 的签名队列仍保留 jev 主判期间的历史——若 jev 放行期间
   * 存在真实重复调用序列，切回 heuristic 的第一轮 decideBeforeIteration 可能
   * 以"旧签名队列"触发 terminate_model_loop（不可恢复）。切换后第一轮：
   * terminate 一律降级为 consult（可恢复），该轮判定完成后标志自动清除。
   */
  private suppressTerminateOnNextDecision = false;

  /**
   * jev 连续 stop 判定计数（观测口径 + reason 文案；架构师审查 P1-5：
   * 清零语义 = acknowledgeAndContinue（用户放行）与模式切换统一清零）
   */
  private jevConsecutiveStops = 0;

  /**
   * 当前预算窗口内已注入的空轮 nudge 次数（校准计划阶段 C）。
   *
   * 硬上限 MAX_NUDGES_PER_WINDOW=3：防 nudge 重试风暴——nudge 是「自愈重试」，
   * 不是无限重发；达上限后空轮治理交还既有「连续空转 → consult」咨询路径。
   * 清零语义与 P1-5 统一：acknowledgeAndContinue（用户放行）时重置窗口。
   */
  private nudgesIssued = 0;

  /**
   * 构造 TurnGuard
   *
   * @param config 配置（缺省字段使用 DEFAULT_TURN_GUARD_CONFIG）
   */
  constructor(config?: Partial<TurnGuardConfig>) {
    this.config = Object.freeze({
      ...DEFAULT_TURN_GUARD_CONFIG,
      ...config,
    });
  }

  /**
   * 简化参数为签名哈希（用于模型循环检测）
   *
   * 提取规则：JSON.stringify 后截取前 200 字符 + 长度后缀。
   * 目的：相同语义的参数产生相同签名，微小差异（如空格、数字精度变化）不影响检测。
   *
   * @param args 原始 tool call 参数（任意可 JSON 序列化的对象）
   * @returns 签名字符串（200 字符内 + 长度标记）
   */
  private static hashToolArgs(args: unknown): string {
    if (args === null || args === undefined) return "";
    let serialized: string;
    try {
      serialized = JSON.stringify(args);
    } catch {
      serialized = String(args);
    }
    // 截取前 200 字符 + 总长度后缀，平衡精度与抗噪声
    const prefix = serialized.length > 200 ? serialized.slice(0, 200) : serialized;
    return `${prefix}#${serialized.length}`;
  }

  /**
   * 记录一次 tool 调用（用于循环检测，2026-10-19 新增）
   *
   * 每轮迭代结束后调用（recordTurn 之后），把本次 LLM 响应中的所有
   * tool call 签名追加到队列头部，超出门槛时从尾部丢弃。
   *
   * 2026-11-10 死循环误杀修复：签名新增可选「结果维度」——调用方按调用顺序
   * 传入每条调用的结果签名（toolResultSignature 产物）。提供结果签名的调用，
   * 仅当「参数相同且结果签名也相同」才计入连续重复；结果变化时签名不同、
   * 尾部连续性被打断（轮询/等待类命令不再被误终止）。未提供结果签名的调用
   * 保持旧行为（仅按工具名+参数判定），既有调用方/测试零回归。
   *
   * @param toolCalls 本轮 LLM 响应中的 tool call 数组（每元素含 name 和 arguments）
   * @param resultSignatures 可选，与 toolCalls 按下标对齐的结果签名数组
   */
  recordToolCalls(
    toolCalls: ReadonlyArray<{ readonly name: string; readonly arguments?: unknown }>,
    resultSignatures?: ReadonlyArray<string | undefined>
  ): void {
    if (!toolCalls || toolCalls.length === 0) return;
    const maxHistory = this.config.trackedToolCallHistory;
    for (let i = 0; i < toolCalls.length; i += 1) {
      const tc = toolCalls[i]!;
      const resultSig = resultSignatures?.[i];
      const sig =
        resultSig !== undefined
          ? `${tc.name}|${TurnGuard.hashToolArgs(tc.arguments)}|${resultSig}`
          : `${tc.name}|${TurnGuard.hashToolArgs(tc.arguments)}`;
      this.toolCallSignatures.push(sig);
      // 超出门槛时从尾部丢弃（保持最近 N 次）
      while (this.toolCallSignatures.length > maxHistory) {
        this.toolCallSignatures.shift();
      }
    }
  }

  /**
   * 检查模型是否陷入死循环（连续相同工具+参数+结果调用，2026-10-19 新增；
   * 2026-11-10 增加结果维度：仅当调用方传入结果签名时才参与判定）
   *
   * 判定规则：
   * 1. maxRepeatedToolCalls > 0（循环检测未禁用）
   * 2. toolCallSignatures 长度 >= maxRepeatedToolCalls
   * 3. 尾部连续 maxRepeatedToolCalls 条签名完全相同
   *
   * @returns 是否检测到模型死循环
   */
  private detectModelLoop(): boolean {
    const { maxRepeatedToolCalls } = this.config;
    if (maxRepeatedToolCalls <= 0) return false;
    if (this.toolCallSignatures.length < maxRepeatedToolCalls) return false;
    const tail = this.toolCallSignatures.slice(-maxRepeatedToolCalls);
    // 所有尾部签名必须相同
    return tail.every((s) => s === tail[0]);
  }

  /**
   * 获取循环检测信息（供判定 reason 详细展示）
   *
   * @returns { toolName, repeatCount } 或 null（未检测到循环）
   */
  private getLoopInfo(): { toolName: string; repeatCount: number } | null {
    if (!this.detectModelLoop()) return null;
    const lastSig = this.toolCallSignatures[this.toolCallSignatures.length - 1];
    const toolName = lastSig.split("|")[0];
    const repeatCount = this.config.maxRepeatedToolCalls;
    return { toolName, repeatCount };
  }

  /**
   * 每轮 LLM 迭代开始前判定是否允许继续
   *
   * 判定优先级（需求124 + 2026-10-19 模型循环检测 + 2026-10-20 轮数上限移除）：
   * 1. 模型死循环 → terminate_model_loop（硬终止，不可恢复）
   * 2. 连续工具全失败 ≥ 上限 → consult_user_consecutive_failures（暂停咨询）
   *
   * 2026-11-10 jev 重构：本方法为 **heuristic 硬兜底路径**——仅在 jev 主判
   * 模式关闭/降级时由调用方调用。jev 主判走 evaluateJevDecision（见下）。
   * 降级首轮（suppressTerminateOnNextDecision）terminate 一律降级为
   * consult_user_loop_stop（架构师审查 P0-1：stale 状态不得导致不可恢复终止）。
   *
   * 已移除的判定：
   * - Token 预算硬终止线（2026-10-19）：上下文压力由
   *   "自动压缩 + 新任务切新上下文"策略接管，不再按 Token 配额终止会话。
   * - 迭代轮数上限（2026-10-20"去掉 40 轮限制"）：原优先级 3 的
   *   consult_user_max_turns 删除——迭代轮数不再触发咨询，长任务可一直执行；
   *   turnsCompleted 保留为观测口径（acknowledgeAndContinue 同步清零）。
   *
   * @returns 判定结果（allow=false 时 reason 可直接展示给用户）
   */
  decideBeforeIteration(): LoopGuardTurnDecision {
    // 0. jev 主判模式短路（方案 §4.1：jev 健康时硬规则不参与判定）。
    //    正常时序下调用方仅在 setJevPrimary(false)（jev 降级/禁用）后才调用本方法；
    //    此处兜底保证 jev 主判期间即使被误调用，硬编码终止规则也不会触发——
    //    循环去留判定权完全归 jev 模型（用户需求 1）。
    if (this.jevPrimary) {
      return { allow: true, reason: "jev 主判模式：heuristic 硬兜底不参与判定" };
    }
    // 1. 模型死循环检测（2026-10-19 新增：最高优先级，防止反复烧 Token）
    const loopInfo = this.getLoopInfo();
    let decision: LoopGuardTurnDecision;
    if (loopInfo) {
      decision = {
        allow: false,
        action: "terminate_model_loop",
        reason:
          `检测到模型死循环：工具 "${loopInfo.toolName}" 连续 ${loopInfo.repeatCount} 次以相同参数被调用。` +
          `任务自动终止，请调整指令后重新开始。`,
      };
    } else if (this.consecutiveFailedTurns >= this.config.maxConsecutiveFailedTurns) {
      // 2. 连续工具全失败（需求124："同一请求拨通3-5次后咨询用户"）
      decision = {
        allow: false,
        action: "consult_user_consecutive_failures",
        reason: `已连续 ${this.consecutiveFailedTurns} 轮工具调用全部失败，继续重试大概率无法自行解决。`,
      };
    } else if (
      // 3. 连续空转轮（2026-10-23 空转护栏）：模型既不产出可见正文、也没有任何
      //    工具执行成功——与判定 1/2 正交：循环检测要求"相同参数"（模型换着命令
      //    空跑则漏检），全失败咨询要求"工具都失败"（工具成功但任务无进展则漏检）。
      this.config.maxConsecutiveEmptyTurns > 0 &&
      this.consecutiveEmptyTurns >= this.config.maxConsecutiveEmptyTurns
    ) {
      decision = {
        allow: false,
        action: "consult_user_empty_turns",
        reason:
          `已连续 ${this.consecutiveEmptyTurns} 轮空转（回复无可见内容且无工具执行成功），` +
          `疑似空循环。请补充更具体的指令，或确认是否继续。`,
      };
    } else {
      decision = { allow: true, reason: "" };
    }

    // 降级首轮禁硬终止（P0-1）：terminate 降级为可恢复咨询，标志一次性消费
    if (this.suppressTerminateOnNextDecision && !decision.allow && decision.action === "terminate_model_loop") {
      decision = {
        allow: false,
        action: "consult_user_loop_stop",
        reason: `jev 降级首轮：检测到疑似死循环调用序列（模式切换残留），` + `暂停执行等待用户确认（不自动终止）。`,
      };
    }
    // 标志一次性消费：首轮判定（无论结果）后恢复正常 heuristic 语义
    this.suppressTerminateOnNextDecision = false;
    return decision;
  }

  /**
   * jev 主判模式切换（2026-11-10 jev 重构，架构师审查 P0-1）
   *
   * 切换语义：
   * - **计数器统一清零**（acknowledgeAndContinue）：模式切换瞬间，heuristic
   *   计数器（连续失败/空转/连续 stop）中的 stale 数据不再参与判定，切换即
   *   给新的预算窗口；
   * - **签名队列清空**：jev 主判期间的调用签名历史属于 jev 判定语境，
   *   切回 heuristic 后不可作为死循环证据（防止 stale 队列触发误终止）；
   * - **降级首轮禁硬终止**：jev → heuristic（降级）方向切换时设置
   *   suppressTerminateOnNextDecision，首轮 terminate 降级为 consult。
   *
   * @param active true = jev 主判；false = heuristic 硬兜底
   */
  setJevPrimary(active: boolean): void {
    if (this.jevPrimary === active) return;
    this.jevPrimary = active;
    this.acknowledgeAndContinue();
    this.toolCallSignatures.length = 0;
    // jev → heuristic（降级）：首轮禁硬终止；heuristic → jev：无需禁用（jev 无 terminate）
    this.suppressTerminateOnNextDecision = !active;
  }

  /** 当前是否 jev 主判模式（观测用） */
  isJevPrimary(): boolean {
    return this.jevPrimary;
  }

  /**
   * 消费 jev 决策结果并产出循环判定（jev 主判路径，2026-11-10）
   *
   * 判定映射（方案 §4.2）：
   * 1. continue_loop = stop 且 confidence ≥ 0.5 → consult_user_loop_stop
   *    （暂停咨询，可恢复；连续第 N 次写入 reason 供用户参考）；
   * 2. continue_loop = stop 但 confidence < 0.5 → 放行（低置信不动作，观测）；
   * 3. continue_loop = continue → 清零连续 stop 计数；
   * 4. is_empty_turn = yes → 空转计数 +1（复用 consecutiveEmptyTurns，语义与
   *    heuristic 空转护栏一致，但判据来自 jev 模型而非硬编码规则）；
   *    达上限 → consult_user_empty_turns；= no → 清零。
   *
   * 注意：本方法**只消费 jev answers**，不读取 heuristic 计数器（除空转计数
   * 复用外）——jev 主判模式下硬编码阈值（重复调用/连续失败）不参与判定。
   * 调用方在 jev 决策失败/不可用时切回 heuristic 后调用 decideBeforeIteration。
   *
   * @param answers jev 决策 answers（continue_loop / is_empty_turn 两问）
   * @returns 判定结果（allow=false 时 reason 可直接展示给用户）
   */
  evaluateJevDecision(answers: Readonly<Record<string, JevAnswer>>): LoopGuardTurnDecision {
    // 1. 循环是否继续（jev 主判核心问题）
    const continueLoop = readChoiceAnswer(answers, "continue_loop");
    if (continueLoop != null && continueLoop.choice === "stop" && continueLoop.confidence >= 0.5) {
      this.jevConsecutiveStops += 1;
      const consecutiveNote =
        this.jevConsecutiveStops > 1 ? `（jev 连续第 ${this.jevConsecutiveStops} 次判定停止）` : "";
      return {
        allow: false,
        action: "consult_user_loop_stop",
        reason:
          `jev 决策模型判定当前循环应停止${consecutiveNote}` +
          `（置信度 ${continueLoop.confidence.toFixed(2)}）。` +
          `已暂停执行：请确认是否继续，或调整指令后重新下达。`,
      };
    }
    if (continueLoop != null && continueLoop.choice === "continue") {
      // continue → 清零连续 stop 计数（P1-5 清零语义）
      this.jevConsecutiveStops = 0;
    }

    // 2. 空循环识别（jev 判据替代硬编码"空文本且无工具成功"规则）
    const emptyTurn = readChoiceAnswer(answers, "is_empty_turn");
    if (emptyTurn != null) {
      if (emptyTurn.choice === "yes") {
        this.consecutiveEmptyTurns += 1;
      } else {
        this.consecutiveEmptyTurns = 0;
      }
      if (
        this.config.maxConsecutiveEmptyTurns > 0 &&
        this.consecutiveEmptyTurns >= this.config.maxConsecutiveEmptyTurns
      ) {
        return {
          allow: false,
          action: "consult_user_empty_turns",
          reason:
            `jev 决策模型判定已连续 ${this.consecutiveEmptyTurns} 轮空循环` +
            `（无可见回复且无有效工具产出）。请补充更具体的指令，或确认是否继续。`,
        };
      }
    }

    return { allow: true, reason: "" };
  }

  /**
   * jev 主判期间的本地硬下限（2026-11-10 空转/误判双修）。
   *
   * jev 决策在工具执行前预取，且健康时 decideBeforeIteration 会短路放行。若 jev
   * 持续误判 continue，真实死循环（相同工具+相同参数+相同结果反复执行）或连续
   * 工具全失败会绕过全部本地护栏，一路烧到用户手动停止——「始终等待却没有进展」。
   * 本方法只读取本轮已落地的可观测证据（签名队列含结果维度、连续失败计数），
   * 不含任何 jev 主观判据，也不查空转（空轮由 jev 判定 + nudge 自愈治理）。
   * 结果签名逐轮变化时 detectModelLoop 不会命中，轮询/等待类正常重复不受影响。
   *
   * 输出一律为可恢复的 consult_*，不产生 terminate_model_loop：jev 主判语境下
   * 不因远程模型放行期累积的签名直接硬终止会话。
   *
   * DEEPCODE_JEV_EVIDENCE_GUARD=0 可回退到「jeV 独占去留权」的旧契约。
   */
  decideJevHardFloor(): LoopGuardTurnDecision {
    if (process.env.DEEPCODE_JEV_EVIDENCE_GUARD === "0") {
      return { allow: true, reason: "" };
    }
    const loopInfo = this.getLoopInfo();
    if (loopInfo) {
      return {
        allow: false,
        action: "consult_user_loop_stop",
        reason:
          `本地硬下限：工具 "${loopInfo.toolName}" 连续 ${loopInfo.repeatCount} 次以相同参数执行且结果无变化。` +
          `jev 主判判定继续，但本地未观察到任何进展；已暂停执行等待确认，请调整指令或回复继续。`,
      };
    }
    if (this.consecutiveFailedTurns >= this.config.maxConsecutiveFailedTurns) {
      return {
        allow: false,
        action: "consult_user_consecutive_failures",
        reason:
          `本地硬下限：已连续 ${this.consecutiveFailedTurns} 轮工具调用全部失败，` + `继续重试大概率无法自行解决。`,
      };
    }
    return { allow: true, reason: "" };
  }

  /**
   * 尝试注入空轮 nudge（校准计划阶段 C：NG1-NG7）。
   *
   * 语义：jev 主判判定本轮空转（is_empty_turn=yes 且置信度达标）且本地复核
   * 确认最近一轮观测确实为空后，调用方注入 NUDGE_MESSAGE 并立即发起下一轮
   * LLM 请求——本方法仅负责预算控制：
   * - 每个预算窗口（acknowledgeAndContinue 清零点）内最多 3 次，防重试风暴；
   * - 达上限返回 false，空轮治理交还既有「连续空转 → consult」路径
   *   （evaluateJevDecision 的 consecutiveEmptyTurns 达限判定不受影响）。
   *
   * @returns true = 允许注入（已计数）；false = 窗口预算耗尽，禁止注入
   */
  tryIssueNudge(): boolean {
    if (this.nudgesIssued >= MAX_NUDGES_PER_WINDOW) {
      return false;
    }
    this.nudgesIssued += 1;
    return true;
  }

  /**
   * 记录一轮迭代结果（LLM 响应 + 工具执行完成后调用）
   *
   * @param result.tokensUsed 本轮 LLM 请求消耗 Token（total_tokens）
   * @param result.hadToolCalls 本轮响应是否包含工具调用
   * @param result.allToolsFailed 本轮工具调用是否全部失败（无工具调用时忽略）
   * @param result.hadVisibleText 本轮响应是否有可见正文（content 去空白非空；
   *        2026-10-23 空转护栏新增。**undefined = 调用方未提供**，本轮不参与
   *        空转判定——既有调用方/测试零回归）
   * @param result.succeededCount 本轮工具执行成功个数（空转判定用；未提供时
   *        以 hadToolCalls && !allToolsFailed 近似）
   */
  recordTurn(result: {
    tokensUsed: number;
    hadToolCalls: boolean;
    allToolsFailed: boolean;
    hadVisibleText?: boolean;
    succeededCount?: number;
  }): void {
    this.turnsCompleted++;
    this.tokensConsumed += Math.max(0, result.tokensUsed);
    if (result.hadToolCalls) {
      if (result.allToolsFailed) {
        this.consecutiveFailedTurns++;
      } else {
        // 任一工具成功 → 清零连续失败计数（问题在推进，不算拨通无果）
        this.consecutiveFailedTurns = 0;
      }
    }
    // 无工具调用（最终回复轮）不影响连续失败计数——主循环在本轮后即 return

    // 2026-10-23 空转护栏：仅当调用方显式提供 hadVisibleText 时参与判定。
    // 空转 = 可见正文为空 且 本轮无工具成功；任一信号为"有产出"即清零。
    if (result.hadVisibleText !== undefined) {
      const hadToolSuccess =
        result.succeededCount !== undefined ? result.succeededCount > 0 : result.hadToolCalls && !result.allToolsFailed;
      if (!result.hadVisibleText && !hadToolSuccess) {
        this.consecutiveEmptyTurns++;
      } else {
        this.consecutiveEmptyTurns = 0;
      }
    }
  }

  /**
   * 用户确认继续后清零咨询触发计数（需求124 咨询-确认闭环）
   *
   * 清零 consecutiveFailedTurns / turnsCompleted（各自给用户新的预算窗口）。
   * tokensConsumed 保留——仅作状态观测（Token 硬终止线已移除，2026-10-19）。
   */
  acknowledgeAndContinue(): void {
    this.consecutiveFailedTurns = 0;
    this.turnsCompleted = 0;
    // 2026-10-23 空转护栏：用户放行同享新的空转预算窗口
    this.consecutiveEmptyTurns = 0;
    // 2026-11-10 jev 重构（P1-5 清零语义）：连续 stop 计数一并清零——
    // 用户放行 = 对 jev 停止判定的人工否决，给新的判定窗口
    this.jevConsecutiveStops = 0;
    // 校准计划阶段 C：nudge 预算窗口随用户放行重置（P1-5 清零语义统一）
    this.nudgesIssued = 0;
  }

  /** 当前状态快照（供审计/展示） */
  getState(): Readonly<{
    turnsCompleted: number;
    tokensConsumed: number;
    consecutiveFailedTurns: number;
    consecutiveEmptyTurns: number;
    jevConsecutiveStops: number;
    jevPrimary: boolean;
    nudgesIssued: number;
  }> {
    return {
      turnsCompleted: this.turnsCompleted,
      tokensConsumed: this.tokensConsumed,
      consecutiveFailedTurns: this.consecutiveFailedTurns,
      consecutiveEmptyTurns: this.consecutiveEmptyTurns,
      jevConsecutiveStops: this.jevConsecutiveStops,
      jevPrimary: this.jevPrimary,
      nudgesIssued: this.nudgesIssued,
    };
  }

  /** 获取配置（只读，冻结） */
  getConfig(): Readonly<TurnGuardConfig> {
    return this.config;
  }
}
