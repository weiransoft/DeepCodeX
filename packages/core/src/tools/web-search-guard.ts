/**
 * 默认 WebSearch 的配额守卫：缓存、并发去重、限流熔断
 *
 * ## 为什么需要这一层
 *
 * 默认模式的搜索走 `https://deepcode.vegamo.cn/api/plugin/web-search`（无
 * Plus 订阅时），按 `machineId` 计配额、与同环境的所有免费用户共享一个池子。
 * 上游对配额的表达方式只有一个：`{"success":false,"reason":"...rate limit
 * exceeded..."}`。**没有任何配额头**——没有 `X-RateLimit-Remaining`、没有
 * `Retry-After`，客户端既算不出余量，也无法精确退避。
 *
 * 在这个前提下，"少打上游"就只能是客户端自己做的功课：
 *
 * 1. **缓存**：同一条 query 在 TTL 内只打一次。模型在一轮里把同一句话搜两遍
 *    很常见（先搜中文再搜英文、或者它忘了自己刚搜过），那次重复是纯浪费。
 *    缓存命中还顺带省掉了语言判定与翻译这两次 LLM 调用。
 * 2. **并发去重**：同一条 query 同时发出两次（并行工具调用）时共享同一个
 *    Promise，避免两倍扣配额。
 * 3. **熔断**：一旦上游明确说限流，本轮就直接拒答，并在错误文案里告诉模型
 *    「不要重试」。不做这一步的话，模型会把它当成普通失败继续重试——每次
 *    重试都真实打一次上游，把已经见底的配额踩得更死，用户看到的就是
 *    「一直在限流」。
 *
 * ## 为什么熔断窗口是 5 分钟
 *
 * 上游不说配额多久恢复，所以这里只是**能挡住重试风暴**的量级：一轮对话里
 * 的重试密集发生在几十秒内，5 分钟足够把它们全部挡在门外；同时又不至于
 * 让用户在配额其实已经恢复的情况下被锁太久（CLI 进程重启也会清空）。
 *
 * ## 进程级单例
 *
 * 缓存与熔断都是「这个进程内发生过什么」，跟着进程走即可（一个 CLI 会话
 * 一个进程）。单例也意味着测试必须显式复位，因此导出 `resetWebSearchGuard`。
 *
 * @module tools/web-search-guard
 */

/** 搜索结果缓存有效期：5 分钟 */
export const SEARCH_CACHE_TTL_MS = 5 * 60_000;

/** 缓存条目上限（超出后淘汰最早写入的） */
export const SEARCH_CACHE_LIMIT = 32;

/** 限流后的熔断窗口：5 分钟 */
export const RATE_LIMIT_COOLDOWN_MS = 5 * 60_000;

/** 守卫参数 */
export interface WebSearchGuardOptions {
  /** 缓存有效期（毫秒） */
  ttlMs?: number;
  /** 缓存条目上限 */
  limit?: number;
  /** 熔断窗口（毫秒） */
  cooldownMs?: number;
  /** 时钟（测试注入） */
  now?: () => number;
}

/** 缓存条目 */
interface CacheEntry {
  output: string;
  storedAt: number;
}

/**
 * 缓存 + 去重 + 熔断
 *
 * 三个机制共用一把 key：`host + 归一化 query`。把 host 放进 key 是因为
 * Plus 订阅与非订阅打的是不同上游、内容也不同源；把 query 归一化（去首尾
 * 空白、压缩连续空白、转小写）是因为「  Latest  Node Release 」和
 * 「latest node release」对上游是同一个问题。
 */
export class WebSearchGuard {
  private readonly ttlMs: number;
  private readonly limit: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<string>>();
  /** 熔断截止时间戳（0 表示未熔断） */
  private blockedUntil = 0;

  /**
   * @param options 守卫参数
   */
  constructor(options: WebSearchGuardOptions = {}) {
    this.ttlMs = options.ttlMs ?? SEARCH_CACHE_TTL_MS;
    this.limit = options.limit ?? SEARCH_CACHE_LIMIT;
    this.cooldownMs = options.cooldownMs ?? RATE_LIMIT_COOLDOWN_MS;
    this.now = options.now ?? Date.now;
  }

  /**
   * 生成缓存 key
   *
   * @param query 原始 query
   * @param host 上游 host
   * @returns 归一化后的 key
   */
  keyFor(query: string, host: string): string {
    return `${host}\u0000${query.trim().replace(/\s+/g, " ").toLowerCase()}`;
  }

  /**
   * 读缓存
   *
   * @param key 缓存 key
   * @returns 命中时返回结果文本，未命中返回 null
   */
  read(key: string): string | null {
    const entry = this.cache.get(key);
    if (entry === undefined) return null;
    if (this.now() - entry.storedAt >= this.ttlMs) {
      this.cache.delete(key);
      return null;
    }
    // 命中即刷新写入顺序：Map 保序，用来近似 LRU
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.output;
  }

  /**
   * 写缓存
   *
   * @param key 缓存 key
   * @param output 搜索结果
   */
  write(key: string, output: string): void {
    this.cache.delete(key);
    this.cache.set(key, { output, storedAt: this.now() });
    while (this.cache.size > this.limit) {
      const oldest = this.cache.keys().next();
      if (oldest.done === true) break;
      this.cache.delete(oldest.value);
    }
  }

  /**
   * 共享在途请求
   *
   * 同一条 query 并发调用时只真正执行一次，其余拿到同一个 Promise。
   *
   * @param key 缓存 key
   * @param factory 真正的请求
   * @returns 搜索结果
   */
  async share(key: string, factory: () => Promise<string>): Promise<string> {
    const running = this.inFlight.get(key);
    if (running !== undefined) return running;
    const task = factory().finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, task);
    return task;
  }

  /** 触发熔断（上游明确返回限流时调用） */
  trip(): void {
    this.blockedUntil = this.now() + this.cooldownMs;
  }

  /**
   * 熔断剩余时长
   *
   * @returns 毫秒；0 表示未熔断
   */
  blockedForMs(): number {
    const remaining = this.blockedUntil - this.now();
    return remaining > 0 ? remaining : 0;
  }

  /** 清空缓存与熔断状态（测试与「手动恢复」用） */
  reset(): void {
    this.cache.clear();
    this.inFlight.clear();
    this.blockedUntil = 0;
  }
}

/** 进程级守卫实例（缓存与熔断跟着进程走） */
export const webSearchGuard = new WebSearchGuard();

/** 复位进程级守卫（测试用） */
export function resetWebSearchGuard(): void {
  webSearchGuard.reset();
}

/**
 * 熔断期间给模型看的错误文案
 *
 * 文案是**给模型读的**，不是给用户看的，所以必须写成可执行指令：说清楚
 * 「不要再调这个工具」以及「现在该怎么办」。只写「rate limited」的话，
 * 模型只会换个 query 再试一次。
 *
 * @param remainingMs 熔断剩余时长
 * @returns 错误文案
 */
export function rateLimitCooldownMessage(remainingMs: number): string {
  const minutes = Math.max(1, Math.ceil(remainingMs / 60_000));
  return `WebSearch 配额已用尽（上游返回限流），已暂停搜索约 ${minutes} 分钟。不要重试 WebSearch —— 重试只会继续消耗同一份配额；请基于已有信息作答，或直接告诉用户稍后再试。`;
}
