/**
 * 缓存规范包（Cache Specification，§5.8.2）
 *
 * 本模块实现 EAG 方案 §5.8.2 缓存规范的运行期访问入口：
 * - 定义统一抽象接口 CachePort（get / set / delete / getWithRebuild / doubleWrite）
 * - 实现 MultiLevelCache 多级缓存（本地缓存 + Redis 双写）
 * - 实现"三防设计"：穿透（空值缓存 + 布隆过滤器）、击穿（热点 key 互斥重建 mutex）、雪崩（TTL 抖动 ±20%）
 * - 实现双写一致性："先更库后删缓存"（对齐 TCS-CACHE-02 红线，禁"先删缓存"）
 *
 * 设计依据：
 * - EAG 方案 §5.8.2 缓存规范
 * - §5.12.4 G-A6d 配置冻结原则（不可变优先）
 * - 缓存三防设计标准实践（穿透/击穿/雪崩）
 * - Cache-Aside / Read-Through / Write-Behind 模式
 *
 * 红线合规设计：
 * - TCS-CACHE-01：CacheSetOptions.ttlSeconds 必填，未提供时抛错；ttlExempt=true 须在豁免清单内
 * - TCS-CACHE-02：doubleWrite 方法强制 order="db-then-delete-cache"，禁"先删缓存"
 * - TCS-CACHE-03：set 方法支持 nullCache=true，对空结果进行缓存（穿透防护）
 *
 * @module eag/tcs/cache
 */

import type { CacheKeyParams, CacheSetOptions, CacheGetResult, CacheDoubleWriteResult, CacheTier } from "./types";

// ============================================================================
// 1. 默认配置常量
// ============================================================================

/**
 * 默认本地缓存 TTL（秒，60 即 1 分钟）
 *
 * 对齐 §5.8.2 规范"本地缓存（Caffeine/Map，秒级）"——本地缓存仅用于读多写少的字典类数据。
 */
export const DEFAULT_LOCAL_TTL_SECONDS = 60;

/**
 * 默认 Redis 缓存 TTL（秒，600 即 10 分钟）
 *
 * 对齐 §5.8.2 规范"Redis（分钟级）"——Redis 作为分布式缓存的二级缓存。
 */
export const DEFAULT_REDIS_TTL_SECONDS = 600;

/**
 * 默认 TTL 抖动比例（0.2 即 ±20%）
 *
 * 对齐 §5.8.2 规范"雪崩防护——TTL 加随机抖动 ±20%"——
 * 防止大量缓存在同一时刻失效导致雪崩。
 */
export const DEFAULT_TTL_JITTER_RATIO = 0.2;

/**
 * 默认互斥锁过期时间（秒，30 秒）
 *
 * 对齐 §5.8.2 规范"击穿防护——热点 key 互斥重建 mutex"——
 * 锁过期时间应大于缓存重建耗时（典型重建 <5 秒，留 6 倍余量）。
 */
export const DEFAULT_MUTEX_EXPIRY_SECONDS = 30;

/**
 * 默认空值缓存 TTL（秒，60 秒）
 *
 * 对齐 §5.8.2 规范"穿透防护——空值缓存"——
 * 空值缓存 TTL 应较短（避免数据更新后空值缓存未失效），但足够防止穿透。
 */
export const DEFAULT_NULL_CACHE_TTL_SECONDS = 60;

/**
 * 默认布隆过滤器预期元素数量（10000）
 *
 * 用于初始化布隆过滤器，预期元素数量影响布隆过滤器大小与哈希函数数量。
 */
export const DEFAULT_BLOOM_EXPECTED_ITEMS = 10000;

/**
 * 默认布隆过滤器误判率（0.01 即 1%）
 *
 * 布隆过滤器的误判率影响所需位数组大小，1% 是性能与内存平衡点。
 */
export const DEFAULT_BLOOM_FALSE_POSITIVE_RATE = 0.01;

// ============================================================================
// 2. Redis 客户端抽象（依赖注入）
// ============================================================================

/**
 * Redis 客户端接口（抽象 Redis 传输层）
 *
 * MultiLevelCache 通过此接口与 Redis 解耦：
 * - 生产环境：注入真实 Redis 客户端（如 ioredis）
 * - 测试环境：注入 StaticRedisClient（内存 Map + 真实 TTL 实现的真实实现，非 mock）
 *
 * 接口契约只暴露 MultiLevelCache 需要的方法，避免对 Redis 客户端的具体实现耦合。
 */
export interface RedisClient {
  /**
   * 获取缓存值
   *
   * @param key 缓存 Key
   * @returns 缓存值（字符串形式，由调用方反序列化）；不存在时返回 null
   */
  get(key: string): Promise<string | null>;

  /**
   * 设置缓存值（含 TTL）
   *
   * @param key 缓存 Key
   * @param value 缓存值（字符串形式，由调用方序列化）
   * @param ttlSeconds TTL（秒，对齐 TCS-CACHE-01 红线，必填）
   */
  set(key: string, value: string, ttlSeconds: number): Promise<void>;

  /**
   * 删除缓存值
   *
   * @param key 缓存 Key
   */
  del(key: string): Promise<void>;

  /**
   * 设置 NX 锁（仅当 key 不存在时设置，原子操作）
   *
   * 用于实现热点 key 互斥重建 mutex。
   *
   * @param key 锁 Key
   * @param value 锁值（持有者 ID）
   * @param ttlSeconds 锁过期时间（秒）
   * @returns true 表示获取锁成功，false 表示锁已被持有
   */
  setNx(key: string, value: string, ttlSeconds: number): Promise<boolean>;

  /**
   * 删除 NX 锁（仅当 value 匹配时删除，原子操作，Lua 脚本实现）
   *
   * 用于安全释放互斥锁（避免误删他人持有的锁）。
   *
   * @param key 锁 Key
   * @param expectedValue 期望的锁值（持有者 ID）
   * @returns true 表示删除成功（锁属于当前持有者），false 表示锁不属于当前持有者
   */
  delIfMatch(key: string, expectedValue: string): Promise<boolean>;
}

// ============================================================================
// 3. 缓存值序列化器（抽象）
// ============================================================================

/**
 * 缓存值序列化器接口
 *
 * 将任意类型的缓存值序列化为字符串（存入 Redis）与反序列化回原类型（从 Redis 读取）。
 * 默认实现使用 JSON 序列化，业务方可自定义实现（如使用 MessagePack 提升性能）。
 */
export interface CacheSerializer {
  /**
   * 序列化
   *
   * @param value 缓存值
   * @returns 序列化字符串
   */
  serialize(value: unknown): string;

  /**
   * 反序列化
   *
   * @param raw 序列化字符串
   * @returns 缓存值
   */
  deserialize(raw: string): unknown;
}

/**
 * JSON 序列化器（默认实现）
 *
 * 使用 JSON.stringify / JSON.parse 实现序列化。
 * 优势：标准库原生支持，无外部依赖。
 * 劣势：性能较 MessagePack 低，不支持 Date/RegExp 等特殊类型自动还原。
 */
export class JsonCacheSerializer implements CacheSerializer {
  serialize(value: unknown): string {
    return JSON.stringify(value);
  }

  deserialize(raw: string): unknown {
    return JSON.parse(raw);
  }
}

// ============================================================================
// 4. 布隆过滤器（穿透防护）
// ============================================================================

/**
 * 布隆过滤器实现（穿透防护）
 *
 * 用于判断一个 key 是否"可能存在"于缓存中：
 * - 返回 false：key 一定不存在（可直接拒绝查询，避免穿透到 DB）
 * - 返回 true：key 可能存在（需进一步查询缓存/DB）
 *
 * 算法：
 * 1. 初始化位数组（bit array），长度 m 由预期元素数量 n 与误判率 p 计算
 * 2. 初始化 k 个哈希函数
 * 3. 添加元素：将元素经 k 个哈希函数得到 k 个位置，位数组对应位置设为 1
 * 4. 查询元素：将元素经 k 个哈希函数得到 k 个位置，若任一位置为 0 则元素不存在
 *
 * 布隆过滤器特性：
 * - 空间效率高（10 万元素 1% 误判率仅需 ~120KB）
 * - 时间效率高（O(k)，k 通常 7~10）
 * - 误判率可控（通过调整 m 与 k）
 * - 不可删除（位数组只能置 1，不能复位）
 *
 * 对齐 §5.8.2 规范"穿透防护——布隆过滤器"——
 * 用于拦截"明显不存在"的 key 查询，避免穿透到 DB。
 */
export class BloomFilter {
  /** 位数组（使用 Uint8Array 模拟位数组，每字节存 8 位） */
  private readonly bits: Uint8Array;
  /** 位数组总位数 */
  private readonly bitCount: number;
  /** 哈希函数数量 */
  private readonly hashFunctionCount: number;
  /** 已添加元素数量（用于统计） */
  private addedCount = 0;

  /**
   * 构造布隆过滤器
   *
   * @param expectedItems 预期元素数量
   * @param falsePositiveRate 误判率（0~1）
   */
  constructor(
    expectedItems: number = DEFAULT_BLOOM_EXPECTED_ITEMS,
    falsePositiveRate: number = DEFAULT_BLOOM_FALSE_POSITIVE_RATE
  ) {
    if (expectedItems <= 0) {
      throw new Error("预期元素数量必须 >0");
    }
    if (falsePositiveRate <= 0 || falsePositiveRate >= 1) {
      throw new Error("误判率必须在 (0, 1) 范围内");
    }

    // 计算最优位数组大小 m：m = -n * ln(p) / (ln(2)^2)
    const m = Math.ceil((-expectedItems * Math.log(falsePositiveRate)) / Math.log(2) ** 2);
    // 计算最优哈希函数数量 k：k = (m/n) * ln(2)
    const k = Math.max(1, Math.round((m / expectedItems) * Math.log(2)));

    this.bitCount = m;
    this.hashFunctionCount = k;
    // 使用 Uint8Array 模拟位数组（每字节 8 位）
    this.bits = new Uint8Array(Math.ceil(m / 8));
  }

  /**
   * 添加元素到布隆过滤器
   *
   * @param element 元素（字符串）
   */
  add(element: string): void {
    const positions = this.getHashPositions(element);
    for (const pos of positions) {
      // 设置位数组对应位置为 1
      const byteIndex = Math.floor(pos / 8);
      const bitIndex = pos % 8;
      this.bits[byteIndex]! |= 1 << bitIndex;
    }
    this.addedCount++;
  }

  /**
   * 查询元素是否可能存在
   *
   * @param element 元素（字符串）
   * @returns true 表示可能存在（需进一步验证），false 表示一定不存在
   */
  mightContain(element: string): boolean {
    const positions = this.getHashPositions(element);
    for (const pos of positions) {
      const byteIndex = Math.floor(pos / 8);
      const bitIndex = pos % 8;
      if ((this.bits[byteIndex]! & (1 << bitIndex)) === 0) {
        return false;
      }
    }
    return true;
  }

  /**
   * 获取已添加元素数量
   */
  getAddedCount(): number {
    return this.addedCount;
  }

  /**
   * 计算元素的哈希位置（k 个位置）
   *
   * 使用双哈希算法（Double Hashing）：
   * h_i(x) = (h1(x) + i * h2(x)) mod m
   * 仅需两个独立哈希函数即可生成 k 个位置，性能优于 k 个独立哈希函数。
   *
   * @param element 元素
   * @returns k 个哈希位置
   */
  private getHashPositions(element: string): number[] {
    // 使用简单的 FNV-1a 哈希作为基础哈希函数
    const h1 = fnv1aHash(element);
    const h2 = murmurHash3(element, h1);

    const positions: number[] = [];
    for (let i = 0; i < this.hashFunctionCount; i++) {
      // 双哈希：h_i = (h1 + i * h2) mod m
      // 使用 BigInt 防止大数溢出（虽然 m 通常小于 Number.MAX_SAFE_INTEGER，但 h1 + i * h2 可能溢出）
      const pos = Number((BigInt(h1) + BigInt(i) * BigInt(h2)) % BigInt(this.bitCount));
      positions.push(pos);
    }
    return positions;
  }
}

/**
 * FNV-1a 哈希算法（32 位）
 *
 * 简单高效的字符串哈希算法，用于布隆过滤器的基础哈希函数。
 *
 * @param str 输入字符串
 * @returns 32 位哈希值（无符号整数）
 */
function fnv1aHash(str: string): number {
  let hash = 0x811c9dc5; // FNV offset basis (2166136261)
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    // 等价于 hash * 16777619（FNV prime），用 Math.imul 处理 32 位整数溢出
    hash = Math.imul(hash, 0x01000193);
  }
  // 转为无符号 32 位整数
  return hash >>> 0;
}

/**
 * MurmurHash3 哈希算法（32 位，简化实现）
 *
 * 用于布隆过滤器的第二个哈希函数（与 FNV-1a 配合双哈希算法）。
 *
 * @param str 输入字符串
 * @param seed 种子（用于生成不同的哈希值）
 * @returns 32 位哈希值（无符号整数）
 */
function murmurHash3(str: string, seed: number): number {
  const c1 = 0xcc9e2d51;
  const c2 = 0x1b873593;
  let hash = seed;

  // 按 4 字节块处理
  const len = str.length;
  const roundedEnd = len & ~0x3;
  for (let i = 0; i < roundedEnd; i += 4) {
    let k =
      (str.charCodeAt(i) & 0xff) |
      ((str.charCodeAt(i + 1) & 0xff) << 8) |
      ((str.charCodeAt(i + 2) & 0xff) << 16) |
      ((str.charCodeAt(i + 3) & 0xff) << 24);
    k = Math.imul(k, c1);
    k = (k << 15) | (k >>> 17);
    k = Math.imul(k, c2);
    hash ^= k;
    hash = (hash << 13) | (hash >>> 19);
    hash = (Math.imul(hash, 5) + 0xe6546b64) | 0;
  }

  // 处理剩余字节
  let k = 0;
  const rem = len & 0x3;
  if (rem >= 3) k |= (str.charCodeAt(roundedEnd + 2) & 0xff) << 16;
  if (rem >= 2) k |= (str.charCodeAt(roundedEnd + 1) & 0xff) << 8;
  if (rem >= 1) {
    k |= str.charCodeAt(roundedEnd) & 0xff;
    k = Math.imul(k, c1);
    k = (k << 15) | (k >>> 17);
    k = Math.imul(k, c2);
    hash ^= k;
  }

  // 最终混合
  hash ^= len;
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  hash ^= hash >>> 16;

  return hash >>> 0;
}

// ============================================================================
// 5. CachePort 抽象接口
// ============================================================================

/**
 * 缓存统一抽象接口（Port，§5.8.2）
 *
 * 业务代码通过依赖注入获取 CachePort，禁止直接 import MultiLevelCache 实现。
 * 接口契约对齐 §5.8.2 缓存规范。
 */
export interface CachePort {
  /**
   * 读取缓存
   *
   * 按 local → redis → db 顺序读取，命中即返回。
   *
   * @param keyParams Key 生成参数
   * @returns 缓存读取结果（含命中层级、是否空值缓存等信息）
   */
  get<T>(keyParams: CacheKeyParams): Promise<CacheGetResult<T>>;

  /**
   * 写入缓存
   *
   * 同时写入本地缓存与 Redis 缓存（除非 localOnly=true）。
   * 必须提供 TTL（对齐 TCS-CACHE-01 红线），ttlExempt=true 须在豁免清单内。
   *
   * @param keyParams Key 生成参数
   * @param value 缓存值（null 表示空值缓存，对齐 TCS-CACHE-03 红线穿透防护）
   * @param options 写入选项（含 TTL、抖动比例等）
   */
  set<T>(keyParams: CacheKeyParams, value: T | null, options: CacheSetOptions): Promise<void>;

  /**
   * 删除缓存
   *
   * 同时删除本地缓存与 Redis 缓存。
   * 用于双写一致性的"后删缓存"步骤（对齐 TCS-CACHE-02 红线）。
   *
   * @param keyParams Key 生成参数
   */
  delete(keyParams: CacheKeyParams): Promise<void>;

  /**
   * 读取缓存，未命中时通过 loader 加载并回填
   *
   * 实现击穿防护（热点 key 互斥重建 mutex）：
   * 1. 缓存命中则直接返回
   * 2. 缓存未命中则尝试获取互斥锁
   * 3. 获取锁成功：执行 loader 加载数据，回填缓存，释放锁，返回数据
   * 4. 获取锁失败：等待并重试读取缓存（避免并发重建）
   *
   * @param keyParams Key 生成参数
   * @param loader DB 加载函数（缓存未命中时调用）
   * @param options 写入选项（含 TTL、抖动比例等，用于回填缓存）
   * @returns 缓存读取结果（含命中层级、值）
   */
  getWithRebuild<T>(
    keyParams: CacheKeyParams,
    loader: () => Promise<T | null>,
    options: CacheSetOptions
  ): Promise<CacheGetResult<T>>;

  /**
   * 双写一致性（先更库后删缓存）
   *
   * 实现 TCS-CACHE-02 红线要求的"先更库后删缓存"双写顺序：
   * 1. 执行 dbUpdater 更新 DB
   * 2. 删除缓存（local + redis）
   * 3. 返回双写结果（含执行顺序、耗时）
   *
   * @param keyParams Key 生成参数
   * @param dbUpdater DB 更新函数
   * @returns 双写一致性结果
   */
  doubleWrite<T>(keyParams: CacheKeyParams, dbUpdater: () => Promise<T>): Promise<CacheDoubleWriteResult>;
}

// ============================================================================
// 6. 缓存 Key 生成器
// ============================================================================

/**
 * 生成符合 §5.8.2 规范的缓存 Key
 *
 * Key 格式：`{app}:{domain}:{entity}:{id}`
 * - app：应用标识
 * - domain：业务域标识
 * - entity：实体标识
 * - id：实体 ID
 *
 * @param params Key 生成参数
 * @returns 生成的缓存 Key
 */
export function generateCacheKey(params: CacheKeyParams): string {
  if (!params.app) {
    throw new Error("app 不能为空");
  }
  if (!params.domain) {
    throw new Error("domain 不能为空");
  }
  if (!params.entity) {
    throw new Error("entity 不能为空");
  }
  if (params.id === undefined || params.id === null || params.id === "") {
    throw new Error("id 不能为空");
  }
  return `${params.app}:${params.domain}:${params.entity}:${params.id}`;
}

/**
 * 生成互斥锁 Key
 *
 * 锁 Key 格式：`{cacheKey}:mutex`
 * 用于热点 key 互斥重建（同一 cacheKey 同时仅一个请求执行重建）。
 *
 * @param cacheKey 缓存 Key
 * @returns 互斥锁 Key
 */
export function generateMutexKey(cacheKey: string): string {
  return `${cacheKey}:mutex`;
}

// ============================================================================
// 7. TTL 抖动计算（雪崩防护）
// ============================================================================

/**
 * 计算带抖动的 TTL
 *
 * 对齐 §5.8.2 规范"雪崩防护——TTL 加随机抖动 ±20%"——
 * 在原 TTL 基础上加减 [0, jitterRatio * ttlSeconds] 范围的随机值，
 * 避免大量缓存在同一时刻失效导致雪崩。
 *
 * 算法：actualTtl = ttlSeconds * (1 + (Math.random() * 2 - 1) * jitterRatio)
 *
 * @param ttlSeconds 原 TTL（秒）
 * @param jitterRatio 抖动比例（0~1，默认 0.2 即 ±20%）
 * @returns 抖动后的 TTL（秒，至少 1 秒）
 */
export function computeJitteredTtl(ttlSeconds: number, jitterRatio: number = DEFAULT_TTL_JITTER_RATIO): number {
  if (ttlSeconds <= 0) {
    throw new Error("TTL 必须 >0");
  }
  if (jitterRatio < 0 || jitterRatio > 1) {
    throw new Error("抖动比例必须在 [0, 1] 范围内");
  }
  // 计算抖动偏移：[-jitterRatio, +jitterRatio] * ttlSeconds
  const jitterOffset = (Math.random() * 2 - 1) * jitterRatio * ttlSeconds;
  const actualTtl = Math.max(1, Math.round(ttlSeconds + jitterOffset));
  return actualTtl;
}

// ============================================================================
// 8. MultiLevelCache 实现（多级缓存 + 三防设计）
// ============================================================================

/**
 * 多级缓存实现（本地缓存 + Redis 双写）
 *
 * 实现 CachePort 接口，提供：
 * - 多级缓存策略：local（秒级）→ redis（分钟级）→ db
 * - 三防设计：
 *   - 穿透防护：空值缓存（nullCache=true）+ 布隆过滤器（bloomFilter）
 *   - 击穿防护：热点 key 互斥重建 mutex（Redis setNx 实现）
 *   - 雪崩防护：TTL 抖动 ±20%（computeJitteredTtl 实现）
 * - 双写一致性：先更库后删缓存（对齐 TCS-CACHE-02 红线）
 *
 * 业务代码禁止直接 import 本类，必须通过依赖注入获取 CachePort。
 */
export class MultiLevelCache implements CachePort {
  /** 本地缓存（Map 实现，秒级 TTL） */
  private readonly localCache: Map<string, { value: unknown; expiresAt: number }>;
  /** Redis 客户端（依赖注入） */
  private readonly redisClient: RedisClient;
  /** 序列化器（依赖注入，默认 JSON 序列化器） */
  private readonly serializer: CacheSerializer;
  /** 布隆过滤器（穿透防护） */
  private readonly bloomFilter: BloomFilter;
  /** TTL 豁免清单（对齐 TCS-CACHE-01 红线：禁止无 TTL，但豁免清单内的 key 可永久） */
  private readonly ttlExemptKeys: ReadonlySet<string>;
  /** 默认本地缓存 TTL（秒） */
  private readonly defaultLocalTtlSeconds: number;
  /** 默认 Redis 缓存 TTL（秒） */
  private readonly defaultRedisTtlSeconds: number;
  /** 默认互斥锁过期时间（秒） */
  private readonly mutexExpirySeconds: number;
  /** 默认空值缓存 TTL（秒） */
  private readonly nullCacheTtlSeconds: number;

  /**
   * 构造 MultiLevelCache
   *
   * @param redisClient Redis 客户端（依赖注入）
   * @param options 可选配置（序列化器、TTL 豁免清单、默认 TTL 等）
   */
  constructor(
    redisClient: RedisClient,
    options?: {
      serializer?: CacheSerializer;
      ttlExemptKeys?: ReadonlyArray<string>;
      defaultLocalTtlSeconds?: number;
      defaultRedisTtlSeconds?: number;
      mutexExpirySeconds?: number;
      nullCacheTtlSeconds?: number;
      bloomExpectedItems?: number;
      bloomFalsePositiveRate?: number;
    }
  ) {
    this.localCache = new Map();
    this.redisClient = redisClient;
    this.serializer = options?.serializer ?? new JsonCacheSerializer();
    this.ttlExemptKeys = new Set(options?.ttlExemptKeys ?? []);
    this.defaultLocalTtlSeconds = options?.defaultLocalTtlSeconds ?? DEFAULT_LOCAL_TTL_SECONDS;
    this.defaultRedisTtlSeconds = options?.defaultRedisTtlSeconds ?? DEFAULT_REDIS_TTL_SECONDS;
    this.mutexExpirySeconds = options?.mutexExpirySeconds ?? DEFAULT_MUTEX_EXPIRY_SECONDS;
    this.nullCacheTtlSeconds = options?.nullCacheTtlSeconds ?? DEFAULT_NULL_CACHE_TTL_SECONDS;
    this.bloomFilter = new BloomFilter(
      options?.bloomExpectedItems ?? DEFAULT_BLOOM_EXPECTED_ITEMS,
      options?.bloomFalsePositiveRate ?? DEFAULT_BLOOM_FALSE_POSITIVE_RATE
    );
  }

  /**
   * 读取缓存
   *
   * 流程：
   * 1. 检查布隆过滤器（穿透防护）——返回 false 表示一定不存在，直接返回未命中
   * 2. 检查本地缓存（秒级）——命中则返回（localHit=true）
   * 3. 检查 Redis 缓存（分钟级）——命中则回填本地缓存并返回（redisHit=true）
   * 4. 都未命中——返回未命中（调用方可通过 getWithRebuild 触发 DB 加载）
   *
   * 空值缓存命中（nullCacheHit=true）表示穿透防护的空结果缓存命中，
   * 返回 value=null 但 nullCacheHit=true，调用方应直接返回 null 而非查询 DB。
   */
  async get<T>(keyParams: CacheKeyParams): Promise<CacheGetResult<T>> {
    const key = generateCacheKey(keyParams);

    // 步骤 1：布隆过滤器拦截（穿透防护）
    if (!this.bloomFilter.mightContain(key)) {
      // 布隆过滤器返回 false → key 一定不存在 → 直接返回未命中
      return {
        value: null,
        tier: null,
        nullCacheHit: false,
        localHit: false,
        redisHit: false,
      };
    }

    // 步骤 2：检查本地缓存
    const localEntry = this.localCache.get(key);
    if (localEntry !== undefined) {
      // 检查本地缓存是否过期
      if (localEntry.expiresAt > Date.now()) {
        // 本地缓存命中
        // 检查是否为空值缓存标记（使用特殊标记值）
        if (localEntry.value === NULL_CACHE_MARKER) {
          return {
            value: null,
            tier: "local",
            nullCacheHit: true,
            localHit: true,
            redisHit: false,
          };
        }
        return {
          value: localEntry.value as T,
          tier: "local",
          nullCacheHit: false,
          localHit: true,
          redisHit: false,
        };
      } else {
        // 本地缓存已过期，清理
        this.localCache.delete(key);
      }
    }

    // 步骤 3：检查 Redis 缓存
    const redisRaw = await this.redisClient.get(key);
    if (redisRaw !== null) {
      // Redis 命中，反序列化
      // 检查是否为空值缓存标记
      if (redisRaw === NULL_CACHE_MARKER_STRING) {
        // 回填本地缓存（空值缓存）
        this.localCache.set(key, {
          value: NULL_CACHE_MARKER,
          expiresAt: Date.now() + this.nullCacheTtlSeconds * 1000,
        });
        return {
          value: null,
          tier: "redis",
          nullCacheHit: true,
          localHit: false,
          redisHit: true,
        };
      }
      const value = this.serializer.deserialize(redisRaw) as T;
      // 回填本地缓存（提升后续读取性能）
      const localTtl = Math.min(this.defaultLocalTtlSeconds, this.defaultRedisTtlSeconds);
      this.localCache.set(key, {
        value,
        expiresAt: Date.now() + localTtl * 1000,
      });
      return {
        value,
        tier: "redis",
        nullCacheHit: false,
        localHit: false,
        redisHit: true,
      };
    }

    // 步骤 4：本地与 Redis 都未命中
    return {
      value: null,
      tier: null,
      nullCacheHit: false,
      localHit: false,
      redisHit: false,
    };
  }

  /**
   * 写入缓存
   *
   * 实现：
   * 1. 校验 TTL（TCS-CACHE-01 红线）——ttlExempt=true 须在豁免清单内
   * 2. 计算抖动后的 TTL（雪崩防护）
   * 3. 添加 key 到布隆过滤器（穿透防护）
   * 4. 写入本地缓存（localOnly=true 时跳过 Redis）
   * 5. 写入 Redis 缓存
   */
  async set<T>(keyParams: CacheKeyParams, value: T | null, options: CacheSetOptions): Promise<void> {
    const key = generateCacheKey(keyParams);

    // 步骤 1：校验 TTL（TCS-CACHE-01 红线：禁止无 TTL 的 key）
    let effectiveTtlSeconds: number;
    if (options.ttlExempt === true) {
      // TTL 豁免须在豁免清单内
      if (!this.ttlExemptKeys.has(key)) {
        throw new Error(`TCS-CACHE-01 违规：key "${key}" 标记 ttlExempt=true 但未在豁免清单内，禁止无 TTL 缓存`);
      }
      // 豁免清单内的 key 使用一个较大的 TTL（如 1 年）模拟"永久"
      effectiveTtlSeconds = 365 * 24 * 3600;
    } else {
      // 非豁免 key，必须提供 TTL
      if (!options.ttlSeconds || options.ttlSeconds <= 0) {
        throw new Error(
          `TCS-CACHE-01 违规：key "${key}" 未提供 TTL（ttlSeconds 必须 >0）。` +
            "如需永久缓存，请使用 ttlExempt=true 并将 key 加入 ttlExemptKeys 清单。"
        );
      }
      effectiveTtlSeconds = options.ttlSeconds;
    }

    // 步骤 2：计算抖动 TTL（雪崩防护）
    const jitterRatio = options.ttlJitterRatio ?? DEFAULT_TTL_JITTER_RATIO;
    const jitteredRedisTtl = computeJitteredTtl(effectiveTtlSeconds, jitterRatio);
    // 本地缓存 TTL 应短于 Redis（本地缓存秒级、Redis 分钟级）
    const localTtlSeconds = Math.min(this.defaultLocalTtlSeconds, jitteredRedisTtl);

    // 步骤 3：添加 key 到布隆过滤器（穿透防护）
    this.bloomFilter.add(key);

    // 步骤 4：写入本地缓存
    const cacheValue = value === null ? NULL_CACHE_MARKER : value;
    this.localCache.set(key, {
      value: cacheValue,
      expiresAt: Date.now() + localTtlSeconds * 1000,
    });

    // 步骤 5：写入 Redis 缓存（除非 localOnly=true）
    if (!options.localOnly) {
      const redisValue = value === null ? NULL_CACHE_MARKER_STRING : this.serializer.serialize(value);
      // 空值缓存使用较短的 TTL（避免数据更新后空值缓存未失效）
      const redisTtl = options.nullCache ? Math.min(this.nullCacheTtlSeconds, jitteredRedisTtl) : jitteredRedisTtl;
      await this.redisClient.set(key, redisValue, redisTtl);
    }
  }

  /**
   * 删除缓存
   *
   * 同时删除本地缓存与 Redis 缓存，用于双写一致性的"后删缓存"步骤。
   * 注：不删除布隆过滤器中的 key（布隆过滤器不可删除）。
   */
  async delete(keyParams: CacheKeyParams): Promise<void> {
    const key = generateCacheKey(keyParams);
    // 删除本地缓存
    this.localCache.delete(key);
    // 删除 Redis 缓存
    await this.redisClient.del(key);
  }

  /**
   * 读取缓存，未命中时通过 loader 加载并回填
   *
   * 实现击穿防护（热点 key 互斥重建 mutex）：
   * 1. 先尝试读取缓存（get）
   * 2. 缓存命中则直接返回
   * 3. 缓存未命中则尝试获取互斥锁（Redis setNx）
   * 4. 获取锁成功：执行 loader 加载数据，回填缓存，释放锁，返回数据
   * 5. 获取锁失败：等待 50ms 后重试读取缓存（避免并发重建），最多重试 20 次（1 秒）
   */
  async getWithRebuild<T>(
    keyParams: CacheKeyParams,
    loader: () => Promise<T | null>,
    options: CacheSetOptions
  ): Promise<CacheGetResult<T>> {
    // 步骤 1：先尝试读取缓存
    const cached = await this.get<T>(keyParams);
    if (cached.tier !== null) {
      // 缓存命中（含空值缓存命中），直接返回
      return cached;
    }

    // 步骤 2：缓存未命中，尝试获取互斥锁
    const key = generateCacheKey(keyParams);
    const mutexKey = generateMutexKey(key);
    const holderId = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const acquired = await this.redisClient.setNx(mutexKey, holderId, this.mutexExpirySeconds);

    if (acquired) {
      // 步骤 3：获取锁成功，执行 loader 加载数据
      try {
        const value = await loader();
        // 回填缓存（含空值缓存，对齐 TCS-CACHE-03 红线穿透防护）
        await this.set(keyParams, value, { ...options, nullCache: value === null ? true : options.nullCache });
        return {
          value,
          tier: "db",
          nullCacheHit: false,
          localHit: false,
          redisHit: false,
        };
      } finally {
        // 步骤 4：释放锁（仅当锁仍属于当前持有者时删除，避免误删他人锁）
        await this.redisClient.delIfMatch(mutexKey, holderId);
      }
    }

    // 步骤 5：获取锁失败，等待并重试读取缓存
    const maxRetries = 20;
    const retryIntervalMs = 50;
    for (let i = 0; i < maxRetries; i++) {
      await sleep(retryIntervalMs);
      const retryResult = await this.get<T>(keyParams);
      if (retryResult.tier !== null) {
        // 等待期间缓存已被其他线程重建，直接返回
        return retryResult;
      }
    }

    // 重试 20 次仍未命中，最后尝试 loader（兜底，避免无限等待）
    const value = await loader();
    await this.set(keyParams, value, { ...options, nullCache: value === null ? true : options.nullCache });
    return {
      value,
      tier: "db",
      nullCacheHit: false,
      localHit: false,
      redisHit: false,
    };
  }

  /**
   * 双写一致性（先更库后删缓存）
   *
   * 实现 TCS-CACHE-02 红线要求的"先更库后删缓存"双写顺序：
   * 1. 执行 dbUpdater 更新 DB
   * 2. 删除缓存（local + redis）
   * 3. 返回双写结果（含执行顺序 "db-then-delete-cache"、耗时）
   *
   * 注意：禁止"先删缓存后更库"——该顺序在并发场景下会导致缓存与 DB 不一致：
   * - 线程 A 删除缓存
   * - 线程 B 读取缓存未命中，从 DB 加载旧值并回填缓存
   * - 线程 A 更新 DB
   * - 此时缓存为旧值，DB 为新值，不一致
   */
  async doubleWrite<T>(keyParams: CacheKeyParams, dbUpdater: () => Promise<T>): Promise<CacheDoubleWriteResult> {
    const startTime = Date.now();
    // 步骤 1：先更库（DB 更新）
    let dbUpdated = false;
    try {
      await dbUpdater();
      dbUpdated = true;
    } catch {
      // DB 更新失败则不删除缓存（保持缓存与 DB 一致性）
      return {
        dbUpdated: false,
        cacheDeleted: false,
        order: "db-then-delete-cache",
        durationMs: Date.now() - startTime,
      };
    }

    // 步骤 2：后删缓存（缓存删除）
    let cacheDeleted = false;
    try {
      await this.delete(keyParams);
      cacheDeleted = true;
    } catch {
      // 缓存删除失败不回滚 DB（DB 已提交）——记录失败，由补偿任务重试删除
      // 实际生产中应将失败的 cacheDelete 任务入队，由后台 worker 重试
    }

    return {
      dbUpdated,
      cacheDeleted,
      order: "db-then-delete-cache",
      durationMs: Date.now() - startTime,
    };
  }

  /**
   * 获取布隆过滤器统计信息（用于监控）
   */
  getBloomFilterStats(): { addedCount: number } {
    return { addedCount: this.bloomFilter.getAddedCount() };
  }

  /**
   * 获取本地缓存条目数（用于监控）
   */
  getLocalCacheSize(): number {
    return this.localCache.size;
  }

  /**
   * 清理本地缓存中已过期的条目（用于定期清理）
   */
  cleanupExpiredLocalEntries(): number {
    const now = Date.now();
    let removedCount = 0;
    for (const [key, entry] of this.localCache.entries()) {
      if (entry.expiresAt <= now) {
        this.localCache.delete(key);
        removedCount++;
      }
    }
    return removedCount;
  }
}

/**
 * 空值缓存标记（本地缓存内部使用）
 *
 * 使用 Symbol 避免与业务值冲突，标记"该 key 已查询过 DB，结果为空"。
 * 用于穿透防护——空值缓存命中时不查询 DB，直接返回 null。
 */
const NULL_CACHE_MARKER = Symbol("NULL_CACHE_MARKER");

/**
 * 空值缓存标记字符串（Redis 缓存使用）
 *
 * Redis 无法存储 Symbol，使用特殊字符串标记空值缓存。
 */
const NULL_CACHE_MARKER_STRING = "__NULL_CACHE__";

/**
 * 睡眠辅助函数
 *
 * @param ms 睡眠毫秒数
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================================
// 9. 缓存工厂（构造默认 MultiLevelCache 实例）
// ============================================================================

/**
 * 构造默认 MultiLevelCache 实例
 *
 * 业务代码通过此工厂获取 CachePort 实现，符合依赖反转原则。
 *
 * @param redisClient Redis 客户端（依赖注入）
 * @param options 可选配置
 * @returns MultiLevelCache 实例
 */
export function createCache(
  redisClient: RedisClient,
  options?: ConstructorParameters<typeof MultiLevelCache>[1]
): CachePort {
  return new MultiLevelCache(redisClient, options);
}

/**
 * 重新导出缓存类型别名（供外部消费者使用）
 *
 * 将 types.ts 中定义的核心类型透传导出，便于调用方从 cache.ts 单一入口获取：
 * - CacheTier：缓存层级（local / redis / db）
 * - CacheKeyParams：缓存键生成参数
 * - CacheSetOptions：缓存写入选项（含 TTL、抖动比例等）
 *
 * 设计依据：facade 模式——调用方仅需 import { type CacheKeyParams } from "../eag/tcs/cache"，
 * 无需感知类型实际定义在 types.ts 中。
 */
export type { CacheTier, CacheKeyParams, CacheSetOptions };
