/**
 * Super Agent 副作用队列（I2 的落地）
 *
 * ## 语义
 *
 * - **入队在事务内，执行业务在事务外**——保证「状态已提交但副作用尚未发生」是可恢复的中间态。
 * - **按 (kind, key) 合并**：同 kind 同 key 再次入队 → payload 覆盖、立即到期、seq 保留。
 * - **失败退避**：指数退避 + 上限；超过最大重试次数则丢弃并上报健康错误（**不静默吞掉**）。
 *
 * ## 首批副作用类型
 *
 * | kind | 作用 | 失败语义 |
 * |---|---|---|
 * | `assessment` | 对一批候选做 Gate + 研判 | 重试 3 次后记 unavailable |
 * | `launch` | 启动 Worker | 重试 3 次后工单失败 |
 * | `delivery` | 把待投递输入交给 Worker | 重试 3 次后工单失败 |
 * | `reply` | 发送写侧消息 | 重试 5 次后丢弃 |
 *
 * @module super-agent/effects/effects
 */

import type { Store } from "../store/store.js";
import type { SuperAgentRepositories } from "../store/repositories.js";

/** 副作用载荷 */
export interface EffectPayload {
  readonly kind: string;
  readonly key: string;
  readonly payload: unknown;
  readonly attempts: number;
}

/** 副作用处理器 */
export type EffectHandler = (effect: EffectPayload) => Promise<void> | void;

/** 副作用注册选项 */
export interface EffectHandlerOptions {
  /** 并发上限（默认 1——保持顺序） */
  readonly concurrency?: number;
  /** 最大重试次数（默认 3） */
  readonly maxRetries?: number;
  /** 退避基数（毫秒，默认 2000） */
  readonly backoffBaseMs?: number;
  /** 退避上限（毫秒，默认 60000） */
  readonly backoffMaxMs?: number;
}

/** 单个副作用的执行结果 */
export interface EffectOutcome {
  readonly kind: string;
  readonly key: string;
  readonly ok: boolean;
  readonly error?: string;
}

/** 健康条目 */
export interface EffectHealth {
  readonly kind: string;
  readonly consecutiveFailures: number;
  readonly lastError: string | null;
}

/**
 * Effects —— 持久化副作用队列
 */
export class Effects {
  /** 持久层 */
  private readonly store: Store;
  /** 仓储 */
  private readonly repos: SuperAgentRepositories;
  /** 已注册的处理器 */
  private readonly handlers = new Map<string, EffectHandler>();
  /** 已注册处理器的选项 */
  private readonly options = new Map<string, Required<EffectHandlerOptions>>();
  /** 各 kind 的连续失败计数 */
  private readonly consecutiveFailures = new Map<string, number>();
  /** 各 kind 的最后错误 */
  private readonly lastErrors = new Map<string, string | null>();

  /**
   * 构造 Effects
   *
   * @param store 持久层
   * @param repos 仓储
   */
  constructor(store: Store, repos: SuperAgentRepositories) {
    this.store = store;
    this.repos = repos;
  }

  /**
   * 注册一个副作用处理器
   *
   * @param kind 副作用类型
   * @param handler 处理器
   * @param options 选项
   */
  register(kind: string, handler: EffectHandler, options: EffectHandlerOptions = {}): void {
    if (this.handlers.has(kind)) {
      throw new Error(`副作用类型 ${kind} 已注册——每个 kind 只能有一个处理器。`);
    }
    this.handlers.set(kind, handler);
    this.options.set(kind, {
      concurrency: options.concurrency ?? 1,
      maxRetries: options.maxRetries ?? 3,
      backoffBaseMs: options.backoffBaseMs ?? 2000,
      backoffMaxMs: options.backoffMaxMs ?? 60_000,
    });
  }

  /**
   * 处理到期的副作用
   *
   * **一轮内会持续取新到期项**：处理某个副作用时新产生的副作用（如下面
   * `assessment` 派生出 `launch` / `reply`）会在同一轮内继续处理——
   * 否则「接单 → 派工」要等下一个 2 秒周期，端到端时延凭空翻倍。
   * 循环以「本轮处理总数达到 limit」或「没有新的到期项」为终止条件，
   * 不会无限循环（重试一律带未来到期时间）。
   *
   * @param limit 单轮处理上限（默认 50）
   * @returns 本轮的执行结果列表
   */
  async drain(limit = 50): Promise<EffectOutcome[]> {
    const outcomes: EffectOutcome[] = [];
    let processed = 0;

    while (processed < limit) {
      const now = this.store.now();
      const due = this.repos.listDueEffects(now, limit - processed);
      if (due.length === 0) break;

      for (const effect of due) {
        const outcome = await this.runOne(effect);
        outcomes.push(outcome);
        processed += 1;
        if (processed >= limit) break;
      }
    }

    return outcomes;
  }

  /**
   * 处理单个副作用
   *
   * @param effect 到期的副作用
   * @returns 执行结果
   */
  private async runOne(effect: {
    seq: number;
    kind: string;
    key: string;
    payload: unknown;
    attempts: number;
  }): Promise<EffectOutcome> {
    const handler = this.handlers.get(effect.kind);
    if (handler === undefined) {
      // 没有处理器的 kind：直接丢弃并记健康错误——不静默跳过
      this.store.write((tx) => {
        this.repos.deleteEffect(tx, effect.seq);
      });
      this.noteFailure(effect.kind, `未注册处理器，副作用被丢弃（key=${effect.key}）`);
      return {
        kind: effect.kind,
        key: effect.key,
        ok: false,
        error: "未注册处理器",
      };
    }

    try {
      await handler({
        kind: effect.kind,
        key: effect.key,
        payload: effect.payload,
        attempts: effect.attempts,
      });
      this.store.write((tx) => {
        this.repos.deleteEffect(tx, effect.seq);
      });
      this.noteSuccess(effect.kind);
      return { kind: effect.kind, key: effect.key, ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const options = this.options.get(effect.kind);
      const maxRetries = options?.maxRetries ?? 3;
      const attempts = effect.attempts + 1;

      if (attempts > maxRetries) {
        // 超过重试上限：丢弃并上报健康错误（数据不丢——领域状态已在 SQLite）
        this.store.write((tx) => {
          this.repos.deleteEffect(tx, effect.seq);
        });
        this.noteFailure(effect.kind, `重试 ${attempts} 次后放弃：${message}`);
      } else {
        const backoff = Math.min(
          (options?.backoffBaseMs ?? 2000) * 2 ** (attempts - 1),
          options?.backoffMaxMs ?? 60_000
        );
        const nextDue = new Date(Date.parse(this.store.now()) + backoff).toISOString();
        this.store.write((tx) => {
          this.repos.markEffectFailed(tx, effect.seq, message, nextDue);
        });
        this.noteFailure(effect.kind, message);
      }
      return { kind: effect.kind, key: effect.key, ok: false, error: message };
    }
  }

  /** 统计队列积压 */
  pending(): Record<string, number> {
    return this.repos.countEffectsByKind();
  }

  /** 健康状态 */
  health(): EffectHealth[] {
    const kinds = new Set<string>([...this.handlers.keys(), ...this.consecutiveFailures.keys()]);
    return [...kinds]
      .map((kind) => ({
        kind,
        consecutiveFailures: this.consecutiveFailures.get(kind) ?? 0,
        lastError: this.lastErrors.get(kind) ?? null,
      }))
      .sort((a, b) => a.kind.localeCompare(b.kind));
  }

  /** 记录一次成功 */
  private noteSuccess(kind: string): void {
    this.consecutiveFailures.set(kind, 0);
    this.lastErrors.set(kind, null);
  }

  /** 记录一次失败 */
  private noteFailure(kind: string, message: string): void {
    const current = this.consecutiveFailures.get(kind) ?? 0;
    this.consecutiveFailures.set(kind, current + 1);
    this.lastErrors.set(kind, message);
  }
}
