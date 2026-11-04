/**
 * Super Agent 周期调度（Passes）
 *
 * ## 语义（对齐 DSH `src/app/passes.ts`）
 *
 * - **每次只跑一个 pass**——串行，避免状态竞态。
 * - **运行中到达的请求合并到下一轮**——突发流量不会堆积成无限队列。
 * - 默认间隔 2 秒——与 DSH 一致；对应「批量攒批」的收益：
 *   Trigger 到达率 1 → 40 条/分钟时，单决定分摊推理时间 6.4s → 1.6s。
 *
 * @module super-agent/passes/passes
 */

/** Passes 构造选项 */
export interface PassesOptions {
  /** 单轮执行的逻辑 */
  readonly onTick: () => Promise<void>;
  /** 轮询间隔（毫秒，默认 2000） */
  readonly intervalMs?: number;
}

/**
 * Passes —— 周期调度器
 */
export class Passes {
  /** 单轮执行逻辑 */
  private readonly onTick: () => Promise<void>;
  /** 轮询间隔 */
  private readonly intervalMs: number;
  /** 定时器句柄 */
  private timer: ReturnType<typeof setInterval> | null = null;
  /** 是否有请求在等待下一轮 */
  private pending = false;
  /** 正在执行中 */
  private running = false;
  /** 是否已停止 */
  private stopped = false;

  /**
   * 构造 Passes
   *
   * @param options 构造选项
   */
  constructor(options: PassesOptions) {
    this.onTick = options.onTick;
    this.intervalMs = options.intervalMs ?? 2000;
  }

  /** 启动调度 */
  start(): void {
    if (this.timer !== null) return;
    this.stopped = false;
    this.timer = setInterval(() => {
      void this.request();
    }, this.intervalMs);
    // Node 定时器不应阻止进程退出
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  /** 停止调度 */
  stop(): void {
    this.stopped = true;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * 请求执行一轮
   *
   * 运行中到达的请求被合并——下一轮统一处理。
   */
  async request(): Promise<void> {
    if (this.stopped) return;
    if (this.running) {
      this.pending = true;
      return;
    }
    await this.runOnce();
    if (this.pending) {
      this.pending = false;
      await this.runOnce();
    }
  }

  /**
   * 同步跑一轮（供 `--once` 模式与测试使用）
   *
   * @returns 本轮是否真的执行了
   */
  async tick(): Promise<boolean> {
    if (this.running) {
      this.pending = true;
      return false;
    }
    await this.runOnce();
    return true;
  }

  /** 实际执行一轮 */
  private async runOnce(): Promise<void> {
    this.running = true;
    try {
      await this.onTick();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[super-agent] pass 执行失败: ${message}`);
    } finally {
      this.running = false;
    }
  }
}
