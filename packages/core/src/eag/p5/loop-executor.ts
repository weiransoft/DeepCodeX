/**
 * EAG-P5 Phase 5.2 LoopExecutor 分流器（TASK-P5-1.2-008）
 *
 * 本模块实现 `P5LoopExecutor` 类，是 AutonomousOrchestrator 4 阶段循环
 * 的"阶段分流器"，负责根据 stage 字面量将执行流路由到对应的 StageHandler。
 *
 * 核心职责（对齐架构师审查 §4.1 + §2.1.3）：
 * 1. 构造时接收 4 个 StageHandler（plan/dev/verify/fix 各一个）
 * 2. execute(stage, ctx) 根据 stage 分流到对应 handler.handle(ctx)
 * 3. 阶段值校验：拒绝非 P5_STAGE_KINDS 内的非法 stage（fail-closed）
 * 4. 异常兜底：handler 抛出异常时返回 fatal StageResult（不让异常冒泡到 Orchestrator）
 * 5. 不可变优先：handlers 数组 ReadonlyArray，返回结果 Object.freeze
 *
 * 与 eag/long-horizon/eag-run-handler.ts 的 LoopExecutor 协议的差异：
 * - long-horizon 版：面向 EagRunHandler，路由 Loop 类型（design/coding/testing）
 *   接口：execute(LoopExecutionContext) → LoopExecutionResult
 * - P5 版（本模块）：面向 AutonomousOrchestrator，路由 4 阶段（plan/dev/verify/fix）
 *   接口：execute(stage, P5StageContext) → P5StageResult
 * - 两者通过命名空间隔离：本模块导出 P5LoopExecutor，不与 long-horizon 冲突
 *
 * 关键技术决策：
 * - 同步分流 + 异步执行：execute 立即分流到 handler，但 handler.handle() 是 async
 * - 异常隔离：handler 抛错不传播，转换为 fatal StageResult 返回
 * - 零新增依赖：仅复用 handlers/types.ts 的 P5StageHandler 协议
 * - 真实实现：不使用 mock/占位，直接调用真实 handler.handle()
 *
 * 不可变优先原则（对齐 §5.12.4 G-A6d 配置冻结）：
 * - 所有接口字段使用 readonly 修饰
 * - handlers 字典使用 Readonly<Record<P5StageKind, P5StageHandler>>
 * - 顶层配置常量使用 Object.freeze 冻结
 * - 工厂函数返回冻结对象
 *
 * @module eag/p5/loop-executor
 */

import type { P5StageContext, P5StageHandler, P5StageResult, P5StageKind } from "./handlers/types";
import { P5_STAGE_KINDS, createFailedStageResult } from "./handlers/types";

// ============================================================================
// 1. 常量定义（不可变，Object.freeze 冻结）
// ============================================================================

/**
 * 分流器执行单阶段的内部超时上限（毫秒，NFR-7 性能保护）
 *
 * 此处仅用于异常兜底日志的时间戳计算，不实际阻塞 handler 执行
 * （handler 内部应自行实现超时控制，如 verify-stage-handler 的 spawnSync timeout）。
 *
 * 取值 0 表示不限超时，由 handler 内部决定。
 */
const P5_LOOP_EXECUTOR_TIMEOUT_MS = 0 as const;

// ============================================================================
// 2. 类型定义（不可变优先，所有字段 readonly）
// ============================================================================

/**
 * 分流器构造选项
 *
 * 用于 P5LoopExecutor 构造时控制行为。
 *
 * 字段全部 readonly——一经构造即不可变。
 */
export interface P5LoopExecutorOptions {
  /**
   * 4 阶段处理器字典
   *
   * 必须包含全部 4 个 P5StageKind（plan/dev/verify/fix）的 handler 实例。
   * 缺任一阶段即拒绝构造（fail-closed，避免运行期 KeyError）。
   */
  readonly handlers: Readonly<Record<P5StageKind, P5StageHandler>>;
  /**
   * 日志回调（可选，默认无操作）
   */
  readonly logger?: P5LoopExecutorLogCallback;
}

/**
 * 日志回调函数类型
 *
 * 复用 run-state-store 的 P5LogCallback 签名（message + level），
 * 但独立命名以避免循环依赖。
 */
export type P5LoopExecutorLogCallback = (message: string, level?: "info" | "warn" | "error") => void;

/**
 * 分流器执行统计（用于可观测性与测试断言）
 *
 * 每次 execute() 调用后累加，可通过 getStats() 读取。
 * 字段全部 readonly——统计快照一经产出即不可变。
 */
export interface P5LoopExecutorStats {
  /** 总分流次数（含失败） */
  readonly totalDispatches: number;
  /** 各阶段分流次数（按 stage 索引） */
  readonly dispatchesByStage: Readonly<Record<P5StageKind, number>>;
  /** 成功次数（handler 返回 kind=success） */
  readonly successCount: number;
  /** 失败次数（handler 返回 kind=failed/retriable） */
  readonly failedCount: number;
  /** 致命错误次数（handler 返回 kind=fatal 或抛异常） */
  readonly fatalCount: number;
  /** 累计耗时（毫秒） */
  readonly totalDurationMs: number;
}

// ============================================================================
// 3. 默认日志空函数
// ============================================================================

/**
 * 默认日志空函数（避免 undefined 判空）
 *
 * 对齐 run-state-store / notes-memory 的 noopLog 模式。
 */
function p5LoopExecutorNoopLog(_message: string, _level?: "info" | "warn" | "error"): void {
  // 默认无操作
}

// ============================================================================
// 4. P5LoopExecutor 主类
// ============================================================================

/**
 * P5LoopExecutor —— 4 阶段循环分流器
 *
 * 设计原则（对齐 Karpathy Simplicity First + Ponytail 红线）：
 *   1. 单一职责：仅做"stage → handler 路由 + 异常兜底"，不参与业务逻辑
 *   2. 真实分流：直接调用 handler.handle()，不模拟、不占位
 *   3. 异常隔离：handler 抛错不传播，转换为 fatal StageResult 返回
 *   4. 不可变产出：返回的 P5StageResult 为冻结对象
 *
 * 使用方式：
 * ```typescript
 * const executor = new P5LoopExecutor({
 *   handlers: {
 *     plan: new P5PlanStageHandler(),
 *     dev: new P5DevStageHandler(),
 *     verify: new P5VerifyStageHandler(),
 *     fix: new P5FixStageHandler(),
 *   },
 * });
 * const result = await executor.execute("plan", ctx);
 * if (result.kind === "success") {
 *   // 处理成功结果
 * }
 * ```
 *
 * 异常处理约定：
 * - handler 内部应自行 try/catch 业务异常并返回 failed/fatal StageResult
 * - 若 handler 未捕获异常（违反约定），分流器兜底转换为 fatal StageResult
 * - 分流器自身不抛异常（除构造时校验失败外）
 */
export class P5LoopExecutor {
  /** 4 阶段处理器字典（不可变） */
  private readonly handlers: Readonly<Record<P5StageKind, P5StageHandler>>;
  /** 日志回调 */
  private readonly log: P5LoopExecutorLogCallback;
  /** 可变统计计数器（内部累加，外部通过 getStats 读取快照） */
  private readonly stats: {
    totalDispatches: number;
    dispatchesByStage: Record<P5StageKind, number>;
    successCount: number;
    failedCount: number;
    fatalCount: number;
    totalDurationMs: number;
  };

  /**
   * @param options 构造选项（含 handlers 字典 + 可选 logger）
   * @throws Error handlers 缺失或阶段不完整时抛出（fail-closed）
   */
  constructor(options: Readonly<P5LoopExecutorOptions>) {
    // 1. 校验入参
    if (!options || typeof options !== "object") {
      throw new Error("P5LoopExecutor 构造失败：options 必须为对象");
    }
    if (!options.handlers || typeof options.handlers !== "object") {
      throw new Error("P5LoopExecutor 构造失败：handlers 必须为对象");
    }

    // 2. 校验 handlers 字典完整性（必须包含全部 4 个阶段）
    const handlers = options.handlers;
    for (const stage of P5_STAGE_KINDS) {
      const handler = (handlers as Record<string, unknown>)[stage];
      if (!handler || typeof (handler as { handle?: unknown }).handle !== "function") {
        throw new Error(`P5LoopExecutor 构造失败：handlers.${stage} 缺失或未实现 P5StageHandler 接口`);
      }
    }

    // 3. 冻结 handlers 字典（防止运行期被 LLM 自改，G-A6d）
    this.handlers = Object.freeze({ ...handlers });
    this.log = options.logger ?? p5LoopExecutorNoopLog;

    // 4. 初始化统计计数器（内部可变，外部只读快照）
    this.stats = {
      totalDispatches: 0,
      dispatchesByStage: {
        plan: 0,
        dev: 0,
        verify: 0,
        fix: 0,
      },
      successCount: 0,
      failedCount: 0,
      fatalCount: 0,
      totalDurationMs: 0,
    };
  }

  // ------------------------------------------------------------------------
  // 公共 API
  // ------------------------------------------------------------------------

  /**
   * 分流执行单个阶段
   *
   * 完整时序：
   * 1. 校验 stage 合法性（必须为 P5_STAGE_KINDS 之一）
   * 2. 从 handlers 字典取出对应 handler
   * 3. 调用 handler.handle(ctx)，异步等待结果
   * 4. 异常兜底：handler 抛错时返回 fatal StageResult
   * 5. 累加统计计数器
   * 6. 返回 P5StageResult（冻结对象）
   *
   * @param stage 阶段（plan/dev/verify/fix）
   * @param ctx 阶段执行上下文（readonly）
   * @returns 阶段执行结果（Promise，冻结对象）
   */
  async execute(stage: P5StageKind, ctx: Readonly<P5StageContext>): Promise<Readonly<P5StageResult>> {
    const startTime = Date.now();

    // 1. 校验 stage 合法性（fail-closed）
    if (!P5_STAGE_KINDS.includes(stage)) {
      this.log(`P5LoopExecutor 拒绝非法 stage：${String(stage)}（合法值：${P5_STAGE_KINDS.join("/")})`, "error");
      const result = createFailedStageResult(
        stage,
        "fatal",
        `非法 stage：${String(stage)}`,
        `stage 必须为 ${P5_STAGE_KINDS.join("/")} 之一，实际值：${String(stage)}`,
        { invalidStage: stage, validStages: Object.freeze([...P5_STAGE_KINDS]) },
        [],
        0,
        Date.now() - startTime
      );
      this.accumulateStats(stage, result, Date.now() - startTime);
      return result;
    }

    // 2. 校验上下文非空
    if (!ctx || typeof ctx !== "object") {
      this.log(`P5LoopExecutor 拒绝空 ctx（stage=${stage}）`, "error");
      const result = createFailedStageResult(
        stage,
        "fatal",
        `阶段 ${stage} 上下文为空`,
        "ctx 必须为非空 P5StageContext 对象",
        { invalidContext: true },
        [],
        0,
        Date.now() - startTime
      );
      this.accumulateStats(stage, result, Date.now() - startTime);
      return result;
    }

    // 3. 从 handlers 字典取出对应 handler
    const handler = this.handlers[stage];

    // 4. 调用 handler.handle(ctx)，异常兜底
    try {
      this.log(`P5LoopExecutor 分流：stage=${stage} iterIndex=${ctx.iterIndex} runId=${ctx.runId}`, "info");

      const result = await handler.handle(ctx);

      // 5. 校验 handler 返回值非空（防御性编程）
      if (!result || typeof result !== "object") {
        this.log(`P5LoopExecutor 检测到 handler ${stage} 返回空结果，转换为 fatal`, "error");
        const fallbackResult = createFailedStageResult(
          stage,
          "fatal",
          `阶段 ${stage} handler 返回空结果`,
          `handler.handle() 返回 ${result === null ? "null" : typeof result}，违反 P5StageHandler 协议`,
          { stage, handlerReturnedEmpty: true },
          [],
          0,
          Date.now() - startTime
        );
        this.accumulateStats(stage, fallbackResult, Date.now() - startTime);
        return fallbackResult;
      }

      // 6. 累加统计并返回
      const durationMs = Date.now() - startTime;
      this.accumulateStats(stage, result, durationMs);

      this.log(`P5LoopExecutor 完成：stage=${stage} kind=${result.kind} duration=${durationMs}ms`, "info");

      return result;
    } catch (err) {
      // 异常兜底：handler 未捕获异常，转换为 fatal StageResult
      const error = err instanceof Error ? err : new Error(String(err));
      this.log(`P5LoopExecutor 捕获 handler ${stage} 异常：${error.message}`, "error");

      const fatalResult = createFailedStageResult(
        stage,
        "fatal",
        `阶段 ${stage} handler 抛出未捕获异常：${error.message}`,
        error.stack ?? error.message,
        {
          stage,
          handlerException: true,
          errorMessage: error.message,
          errorName: error.name,
        },
        [],
        0,
        Date.now() - startTime
      );

      this.accumulateStats(stage, fatalResult, Date.now() - startTime);
      return fatalResult;
    }
  }

  /**
   * 批量顺序执行多个阶段（plan→dev→verify→fix 全流程便捷方法）
   *
   * 算法：
   * 1. 按传入的 stages 顺序依次调用 execute()
   * 2. 任一阶段返回 fatal → 立即中止，返回已完成的结果列表
   * 3. 任一阶段返回 failed → 立即中止（不进入 fix 阶段，由调用方决定是否重试）
   * 4. 全部阶段返回 success → 返回全部结果列表
   *
   * 注意：此方法不会自动构造 fix 阶段上下文，调用方需在 stages 数组中显式包含 "fix"。
   * 此方法主要用于测试场景下的便捷批量执行；生产环境推荐由 AutonomousOrchestrator
   * 自行控制 4 阶段时序，以便在每阶段间插入状态保存与笔记追加。
   *
   * @param stages 阶段顺序数组（如 ["plan", "dev", "verify", "fix"]）
   * @param ctxFactory 上下文工厂（每次调用返回新的 ctx，避免状态污染）
   * @returns 全部已完成的结果列表（按执行顺序）
   */
  async executeBatch(
    stages: ReadonlyArray<P5StageKind>,
    ctxFactory: (stage: P5StageKind, prevResults: ReadonlyArray<Readonly<P5StageResult>>) => Readonly<P5StageContext>
  ): Promise<ReadonlyArray<Readonly<P5StageResult>>> {
    if (!Array.isArray(stages) || stages.length === 0) {
      return Object.freeze([]);
    }

    const results: P5StageResult[] = [];

    for (const stage of stages) {
      // 校验 stage 合法性（execute 内部也会校验，这里提前校验避免构造无效 ctx）
      if (!P5_STAGE_KINDS.includes(stage)) {
        this.log(`P5LoopExecutor.executeBatch 拒绝非法 stage：${String(stage)}`, "error");
        break;
      }

      // 构造上下文（传入前序结果）
      const ctx = ctxFactory(stage, Object.freeze([...results]));
      const result = await this.execute(stage, ctx);
      results.push(result);

      // fatal → 立即中止
      if (result.kind === "fatal") {
        this.log(`P5LoopExecutor.executeBatch 在 stage=${stage} 处遇到 fatal，中止后续阶段`, "warn");
        break;
      }

      // failed → 立即中止（由调用方决定是否重试）
      if (result.kind === "failed") {
        this.log(`P5LoopExecutor.executeBatch 在 stage=${stage} 处遇到 failed，中止后续阶段`, "info");
        break;
      }
    }

    return Object.freeze(results);
  }

  /**
   * 获取支持的全部阶段（不可变）
   *
   * @returns P5_STAGE_KINDS 的副本（冻结）
   */
  getSupportedStages(): ReadonlyArray<P5StageKind> {
    return Object.freeze([...P5_STAGE_KINDS]);
  }

  /**
   * 获取指定阶段的 handler 实例（用于测试断言与可观测性）
   *
   * @param stage 阶段
   * @returns handler 实例（若 stage 非法返回 undefined）
   */
  getHandler(stage: P5StageKind): P5StageHandler | undefined {
    if (!P5_STAGE_KINDS.includes(stage)) {
      return undefined;
    }
    return this.handlers[stage];
  }

  /**
   * 获取分流器执行统计快照（不可变）
   *
   * 用于可观测性与测试断言。返回的是当前统计的冻结快照，
   * 后续累加不影响已返回的快照。
   *
   * @returns 统计快照（readonly，冻结）
   */
  getStats(): Readonly<P5LoopExecutorStats> {
    return Object.freeze({
      totalDispatches: this.stats.totalDispatches,
      dispatchesByStage: Object.freeze({ ...this.stats.dispatchesByStage }),
      successCount: this.stats.successCount,
      failedCount: this.stats.failedCount,
      fatalCount: this.stats.fatalCount,
      totalDurationMs: this.stats.totalDurationMs,
    });
  }

  // ------------------------------------------------------------------------
  // 私有方法
  // ------------------------------------------------------------------------

  /**
   * 累加统计计数器
   *
   * @param stage 阶段
   * @param result 阶段结果
   * @param durationMs 耗时（毫秒）
   */
  private accumulateStats(stage: P5StageKind, result: Readonly<P5StageResult>, durationMs: number): void {
    this.stats.totalDispatches += 1;
    this.stats.dispatchesByStage[stage] += 1;
    this.stats.totalDurationMs += durationMs;

    switch (result.kind) {
      case "success":
        this.stats.successCount += 1;
        break;
      case "failed":
      case "retriable":
        this.stats.failedCount += 1;
        break;
      case "fatal":
        this.stats.fatalCount += 1;
        break;
      default:
        // 防御性：未知 kind 不计入任何计数器，仅记日志
        this.log(`P5LoopExecutor 检测到未知 result.kind：${String(result.kind)}（stage=${stage}）`, "warn");
        break;
    }
  }
}

// ============================================================================
// 5. 工厂函数
// ============================================================================

/**
 * 工厂函数：创建默认 P5LoopExecutor 实例
 *
 * @param options 构造选项
 * @returns P5LoopExecutor 实例
 * @throws Error handlers 缺失或阶段不完整时抛出
 */
export function createP5LoopExecutor(options: Readonly<P5LoopExecutorOptions>): P5LoopExecutor {
  return new P5LoopExecutor(options);
}

/**
 * 工厂函数：从 4 个独立 handler 创建 P5LoopExecutor
 *
 * 提供 plan/dev/verify/fix 四个独立 handler 的便捷构造方式。
 *
 * @param plan plan 阶段 handler
 * @param dev dev 阶段 handler
 * @param verify verify 阶段 handler
 * @param fix fix 阶段 handler
 * @param logger 日志回调（可选）
 * @returns P5LoopExecutor 实例
 */
export function createP5LoopExecutorFromHandlers(
  plan: P5StageHandler,
  dev: P5StageHandler,
  verify: P5StageHandler,
  fix: P5StageHandler,
  logger?: P5LoopExecutorLogCallback
): P5LoopExecutor {
  return new P5LoopExecutor({
    handlers: Object.freeze({ plan, dev, verify, fix }),
    logger,
  });
}

// ============================================================================
// 6. 导出常量（供测试断言）
// ============================================================================

/**
 * 导出 P5_LOOP_EXECUTOR_TIMEOUT_MS（供测试断言）
 *
 * 注：当前为 0（不限超时），由 handler 内部决定。
 */
export { P5_LOOP_EXECUTOR_TIMEOUT_MS };
