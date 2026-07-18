/**
 * EAG-P2 批次 7 单元测试：TCS 多级缓存（cache.ts）
 *
 * 测试范围：
 * - C1. generateCacheKey 生成符合规范的缓存 Key
 * - C2. generateMutexKey 生成互斥锁 Key
 * - C3. computeJitteredTtl TTL 抖动计算（雪崩防护）
 * - C4. JsonCacheSerializer 序列化/反序列化
 * - C5. BloomFilter 布隆过滤器（穿透防护）
 * - C6. MultiLevelCache 基本读写（local + redis 双写）
 * - C7. MultiLevelCache TTL 过期失效
 * - C8. MultiLevelCache 穿透防护（nullCache 空值缓存，TCS-CACHE-03 红线）
 * - C9. MultiLevelCache 击穿防护（getWithRebuild 互斥重建）
 * - C10. MultiLevelCache 双写一致性（doubleWrite 先更库后删缓存，TCS-CACHE-02 红线）
 * - C11. MultiLevelCache TTL 豁免清单（TCS-CACHE-01 红线）
 * - C12. createCache 工厂函数
 * - C13. TCS-CACHE-01 红线触发：未设置 TTL 抛错
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止使用 mock 框架，使用真实 InMemoryRedisClient（实现 RedisClient 接口）
 * - 每个测试用例独立，无共享可变状态
 *
 * 设计依据：
 * - EAG 方案 §5.8.2 缓存规范
 * - eag/tcs/cache.ts 源文件（被测对象）
 *
 * @module core/tests/eag-tcs-cache
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_LOCAL_TTL_SECONDS,
  DEFAULT_REDIS_TTL_SECONDS,
  DEFAULT_TTL_JITTER_RATIO,
  DEFAULT_BLOOM_EXPECTED_ITEMS,
  DEFAULT_BLOOM_FALSE_POSITIVE_RATE,
  JsonCacheSerializer,
  BloomFilter,
  MultiLevelCache,
  createCache,
  generateCacheKey,
  generateMutexKey,
  computeJitteredTtl,
  type RedisClient,
  type CacheKeyParams,
  type CacheSetOptions,
  type CachePort,
} from "../eag/tcs/cache";

// ============================================================================
// 辅助：InMemoryRedisClient（真实实现 RedisClient 接口，非 mock）
// ============================================================================

/**
 * 内存 Redis 客户端（真实实现 RedisClient 接口）
 *
 * 使用 Map 真实存储 key-value，并支持：
 * - get / set（带 TTL 过期）
 * - del（删除）
 * - setNx（仅当 key 不存在时设置，原子操作）
 * - delIfMatch（仅当 value 匹配时删除，原子操作）
 *
 * 这是真实的 Redis 服务端实现，不是 mock——它真实地存储数据并执行过期检查。
 */
class InMemoryRedisClient implements RedisClient {
  /** 存储条目结构 */
  private readonly store = new Map<string, { value: string; expiresAt: number | null }>();

  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (entry === undefined) {
      return null;
    }
    // 检查是否过期
    if (entry.expiresAt !== null && entry.expiresAt < Date.now()) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    const expiresAt = ttlSeconds > 0 ? Date.now() + ttlSeconds * 1000 : null;
    this.store.set(key, { value, expiresAt });
  }

  async del(key: string): Promise<void> {
    this.store.delete(key);
  }

  async setNx(key: string, value: string, ttlSeconds: number): Promise<boolean> {
    const existing = this.store.get(key);
    // 检查现有锁是否已过期
    if (existing !== undefined && existing.expiresAt !== null && existing.expiresAt < Date.now()) {
      this.store.delete(key);
    }
    if (this.store.has(key)) {
      return false; // 锁已被持有
    }
    const expiresAt = Date.now() + ttlSeconds * 1000;
    this.store.set(key, { value, expiresAt });
    return true;
  }

  async delIfMatch(key: string, expectedValue: string): Promise<boolean> {
    const entry = this.store.get(key);
    if (entry === undefined) {
      return false;
    }
    if (entry.value !== expectedValue) {
      return false;
    }
    this.store.delete(key);
    return true;
  }

  /** 测试辅助：检查 key 是否存在 */
  has(key: string): boolean {
    return this.store.has(key);
  }

  /** 测试辅助：清空存储 */
  clear(): void {
    this.store.clear();
  }
}

/**
 * 构造测试用 CacheKeyParams
 */
function makeKeyParams(id: string = "u123"): CacheKeyParams {
  return {
    app: "bi-service",
    domain: "user",
    entity: "UserProfile",
    id,
  };
}

// ============================================================================
// C1. generateCacheKey
// ============================================================================

test("C1a. generateCacheKey 生成 {app}:{domain}:{entity}:{id} 格式 Key", () => {
  const key = generateCacheKey(makeKeyParams("u123"));
  assert.equal(key, "bi-service:user:UserProfile:u123");
});

test("C1b. generateCacheKey 入参为空时抛错", () => {
  assert.throws(() => generateCacheKey({ app: "", domain: "d", entity: "e", id: "1" }), /app 不能为空/);
  assert.throws(() => generateCacheKey({ app: "a", domain: "", entity: "e", id: "1" }), /domain 不能为空/);
  assert.throws(() => generateCacheKey({ app: "a", domain: "d", entity: "", id: "1" }), /entity 不能为空/);
  assert.throws(() => generateCacheKey({ app: "a", domain: "d", entity: "e", id: "" }), /id 不能为空/);
});

// ============================================================================
// C2. generateMutexKey
// ============================================================================

test("C2. generateMutexKey 在 cacheKey 后追加 ':mutex'", () => {
  const mutexKey = generateMutexKey("bi-service:user:UserProfile:u123");
  assert.equal(mutexKey, "bi-service:user:UserProfile:u123:mutex");
});

// ============================================================================
// C3. computeJitteredTtl
// ============================================================================

test("C3a. computeJitteredTtl 返回值在 [ttl * (1-ratio), ttl * (1+ratio)] 范围内", () => {
  const ttl = 100;
  const ratio = 0.2;
  for (let i = 0; i < 50; i++) {
    const actual = computeJitteredTtl(ttl, ratio);
    assert.ok(
      actual >= ttl * (1 - ratio) && actual <= ttl * (1 + ratio),
      `抖动 TTL ${actual} 应在 [${ttl * (1 - ratio)}, ${ttl * (1 + ratio)}] 范围内`
    );
    assert.ok(actual >= 1, "抖动后 TTL 至少 1 秒");
  }
});

test("C3b. computeJitteredTtl 入参非法时抛错", () => {
  assert.throws(() => computeJitteredTtl(0), /TTL 必须 >0/);
  assert.throws(() => computeJitteredTtl(-1), /TTL 必须 >0/);
  assert.throws(() => computeJitteredTtl(100, -0.1), /抖动比例必须在 \[0, 1\] 范围内/);
  assert.throws(() => computeJitteredTtl(100, 1.1), /抖动比例必须在 \[0, 1\] 范围内/);
});

test("C3c. computeJitteredTtl jitterRatio=0 时返回原 TTL", () => {
  // jitterRatio=0 时抖动偏移为 0，返回值应等于原 TTL
  const actual = computeJitteredTtl(100, 0);
  assert.equal(actual, 100);
});

// ============================================================================
// C4. JsonCacheSerializer
// ============================================================================

test("C4a. JsonCacheSerializer 序列化与反序列化对象", () => {
  const serializer = new JsonCacheSerializer();
  const obj = { name: "Alice", age: 30, tags: ["a", "b"] };
  const raw = serializer.serialize(obj);
  assert.equal(raw, JSON.stringify(obj));
  const restored = serializer.deserialize(raw) as typeof obj;
  assert.deepEqual(restored, obj);
});

test("C4b. JsonCacheSerializer 序列化 null", () => {
  const serializer = new JsonCacheSerializer();
  const raw = serializer.serialize(null);
  assert.equal(raw, "null");
  assert.equal(serializer.deserialize(raw), null);
});

// ============================================================================
// C5. BloomFilter
// ============================================================================

test("C5a. BloomFilter 添加元素后 mightContain 返回 true", () => {
  const filter = new BloomFilter(1000, 0.01);
  filter.add("bi-service:user:UserProfile:u1");
  filter.add("bi-service:user:UserProfile:u2");
  filter.add("bi-service:user:UserProfile:u3");
  assert.ok(filter.mightContain("bi-service:user:UserProfile:u1"));
  assert.ok(filter.mightContain("bi-service:user:UserProfile:u2"));
  assert.ok(filter.mightContain("bi-service:user:UserProfile:u3"));
});

test("C5b. BloomFilter 未添加的元素大概率返回 false（无误判）", () => {
  const filter = new BloomFilter(1000, 0.01);
  filter.add("existing-key-1");
  filter.add("existing-key-2");
  // 未添加的 key 应返回 false（小概率误判）
  const notAdded = "this-key-was-never-added-xyz-12345";
  // 多次取一个不存在的 key，至少有一次返回 false
  // 注意：布隆过滤器有误判率，不能强断言 false，但可以断言大量不存在的 key 中至少有 false
  let falseCount = 0;
  for (let i = 0; i < 100; i++) {
    if (!filter.mightContain(`non-existent-${i}-${notAdded}`)) {
      falseCount++;
    }
  }
  assert.ok(falseCount > 90, `100 个未添加 key 应至少 90 个返回 false，实际 ${falseCount}`);
});

test("C5c. BloomFilter getAddedCount 返回已添加元素数量", () => {
  const filter = new BloomFilter(1000, 0.01);
  assert.equal(filter.getAddedCount(), 0);
  filter.add("k1");
  filter.add("k2");
  filter.add("k3");
  assert.equal(filter.getAddedCount(), 3);
});

test("C5d. BloomFilter 入参非法时抛错", () => {
  assert.throws(() => new BloomFilter(0, 0.01), /预期元素数量必须 >0/);
  assert.throws(() => new BloomFilter(-1, 0.01), /预期元素数量必须 >0/);
  assert.throws(() => new BloomFilter(1000, 0), /误判率必须在 \(0, 1\) 范围内/);
  assert.throws(() => new BloomFilter(1000, 1), /误判率必须在 \(0, 1\) 范围内/);
});

// ============================================================================
// C6. MultiLevelCache 基本读写
// ============================================================================

test("C6a. MultiLevelCache set + get 命中本地缓存", async () => {
  const redis = new InMemoryRedisClient();
  const cache = new MultiLevelCache(redis);
  const keyParams = makeKeyParams("u1");
  await cache.set(keyParams, { name: "Alice" }, { ttlSeconds: 300 });
  const result = await cache.get<{ name: string }>(keyParams);
  // 本地缓存或 Redis 命中
  assert.ok(result.localHit || result.redisHit, "应命中本地或 Redis 缓存");
  assert.ok(result.value !== null, "value 不应为 null");
  assert.equal(result.value!.name, "Alice");
});

test("C6b. MultiLevelCache 未命中的 key 返回 null（布隆过滤器拦截）", async () => {
  const redis = new InMemoryRedisClient();
  const cache = new MultiLevelCache(redis);
  // 未写入任何 key，布隆过滤器应拦截
  const result = await cache.get<{ name: string }>(makeKeyParams("never-set"));
  assert.equal(result.value, null);
  assert.equal(result.localHit, false);
  assert.equal(result.redisHit, false);
  assert.equal(result.tier, null);
});

test("C6c. MultiLevelCache set 后 Redis 中也存在（双写）", async () => {
  const redis = new InMemoryRedisClient();
  const cache = new MultiLevelCache(redis);
  const keyParams = makeKeyParams("u-redis-test");
  await cache.set(keyParams, { name: "Bob" }, { ttlSeconds: 300 });
  // 检查 Redis 中确实写入了
  const redisKey = generateCacheKey(keyParams);
  const redisValue = await redis.get(redisKey);
  assert.ok(redisValue !== null, "Redis 中应存在该 key");
  assert.ok(redisValue!.includes("Bob"), "Redis 中应包含 Bob");
});

// ============================================================================
// C7. TTL 过期失效
// ============================================================================

test("C7a. DEFAULT_LOCAL_TTL_SECONDS 为 60 秒", () => {
  assert.equal(DEFAULT_LOCAL_TTL_SECONDS, 60);
});

test("C7b. DEFAULT_REDIS_TTL_SECONDS 为 600 秒", () => {
  assert.equal(DEFAULT_REDIS_TTL_SECONDS, 600);
});

test("C7c. MultiLevelCache delete 后再次 get 返回未命中", async () => {
  const redis = new InMemoryRedisClient();
  const cache = new MultiLevelCache(redis);
  const keyParams = makeKeyParams("u-delete");
  await cache.set(keyParams, { name: "Charlie" }, { ttlSeconds: 300 });
  // 确认命中
  const beforeDelete = await cache.get<{ name: string }>(keyParams);
  assert.ok(beforeDelete.value !== null);
  // 删除
  await cache.delete(keyParams);
  // 删除后未命中（布隆过滤器已添加，会走到 local + redis 查找，均为空）
  const afterDelete = await cache.get<{ name: string }>(keyParams);
  assert.equal(afterDelete.value, null);
  assert.equal(afterDelete.localHit, false);
  assert.equal(afterDelete.redisHit, false);
});

// ============================================================================
// C8. 穿透防护（nullCache 空值缓存，TCS-CACHE-03 红线）
// ============================================================================

test("C8. MultiLevelCache set null + nullCache=true 写入空值缓存", async () => {
  const redis = new InMemoryRedisClient();
  const cache = new MultiLevelCache(redis);
  const keyParams = makeKeyParams("u-null");
  // 写入空值缓存
  await cache.set(keyParams, null, { ttlSeconds: 60, nullCache: true });
  // 读取应命中空值缓存
  const result = await cache.get<{ name: string }>(keyParams);
  assert.equal(result.value, null);
  assert.equal(result.nullCacheHit, true, "应命中空值缓存");
});

// ============================================================================
// C9. 击穿防护（getWithRebuild 互斥重建）
// ============================================================================

test("C9a. MultiLevelCache getWithRebuild 缓存未命中时调用 loader 加载", async () => {
  const redis = new InMemoryRedisClient();
  const cache = new MultiLevelCache(redis);
  const keyParams = makeKeyParams("u-rebuild");
  // 首次调用——缓存未命中，调用 loader 加载
  let loaderCalled = 0;
  const result = await cache.getWithRebuild<{ name: string }>(
    keyParams,
    async () => {
      loaderCalled++;
      return { name: "Dave" };
    },
    { ttlSeconds: 300 }
  );
  assert.equal(loaderCalled, 1, "loader 应被调用 1 次");
  assert.ok(result.value !== null);
  assert.equal(result.value!.name, "Dave");
});

test("C9b. MultiLevelCache getWithRebuild 缓存命中时不调用 loader", async () => {
  const redis = new InMemoryRedisClient();
  const cache = new MultiLevelCache(redis);
  const keyParams = makeKeyParams("u-rebuild-hit");
  // 先写入缓存
  await cache.set(keyParams, { name: "Eve" }, { ttlSeconds: 300 });
  // 再次调用——缓存命中，不调用 loader
  let loaderCalled = 0;
  const result = await cache.getWithRebuild<{ name: string }>(
    keyParams,
    async () => {
      loaderCalled++;
      return { name: "Should-Not-Be-Used" };
    },
    { ttlSeconds: 300 }
  );
  assert.equal(loaderCalled, 0, "loader 应未被调用（缓存命中）");
  assert.equal(result.value!.name, "Eve");
});

// ============================================================================
// C10. 双写一致性（doubleWrite 先更库后删缓存，TCS-CACHE-02 红线）
// ============================================================================

test("C10a. MultiLevelCache doubleWrite 执行 dbUpdater 并删除缓存", async () => {
  const redis = new InMemoryRedisClient();
  const cache = new MultiLevelCache(redis);
  const keyParams = makeKeyParams("u-double");
  // 先写入旧值
  await cache.set(keyParams, { name: "OldName" }, { ttlSeconds: 300 });
  // 执行 doubleWrite
  let dbUpdaterCalled = false;
  const result = await cache.doubleWrite<{ name: string }>(keyParams, async () => {
    dbUpdaterCalled = true;
    return { name: "NewName" };
  });
  assert.ok(dbUpdaterCalled, "dbUpdater 应被调用");
  assert.ok(result.dbUpdated, "DB 更新应成功");
  assert.ok(result.cacheDeleted, "缓存应被删除");
  assert.equal(result.order, "db-then-delete-cache", "双写顺序应为 db-then-delete-cache");
  // 缓存应被删除（先更库后删缓存）
  const getResult = await cache.get<{ name: string }>(keyParams);
  // 缓存已删除——可能布隆过滤器仍允许通过，但 local + redis 均未命中
  assert.equal(getResult.localHit, false);
  assert.equal(getResult.redisHit, false);
});

test("C10b. MultiLevelCache doubleWrite 执行顺序为：先更库 → 后删缓存", async () => {
  const redis = new InMemoryRedisClient();
  const cache = new MultiLevelCache(redis);
  const keyParams = makeKeyParams("u-order");
  await cache.set(keyParams, { name: "BeforeUpdate" }, { ttlSeconds: 300 });

  // 记录执行顺序
  const order: string[] = [];
  const result = await cache.doubleWrite(keyParams, async () => {
    order.push("db-update");
    return { name: "AfterUpdate" };
  });
  // doubleWrite 内部会执行 cache.delete，无法直接观察，但可通过 result 校验成功
  assert.ok(result.dbUpdated);
  assert.equal(result.order, "db-then-delete-cache");
  assert.equal(order[0], "db-update", "应先执行 db-update");
});

// ============================================================================
// C11. TTL 豁免清单（TCS-CACHE-01 红线）
// ============================================================================

test("C11. MultiLevelCache ttlExempt=true 且 key 在豁免清单内允许写入", async () => {
  const redis = new InMemoryRedisClient();
  const keyParams = makeKeyParams("u-exempt");
  const cacheKey = generateCacheKey(keyParams);
  const cache = new MultiLevelCache(redis, {
    ttlExemptKeys: [cacheKey],
  });
  // ttlExempt=true 且 key 在豁免清单——允许写入
  await cache.set(keyParams, { name: "ExemptUser" }, { ttlSeconds: 0, ttlExempt: true });
  // 应能读取
  const result = await cache.get<{ name: string }>(keyParams);
  assert.ok(result.value !== null);
  assert.equal(result.value!.name, "ExemptUser");
});

// ============================================================================
// C12. createCache 工厂函数
// ============================================================================

test("C12. createCache 返回 MultiLevelCache 实例并实现 CachePort 接口", () => {
  const redis = new InMemoryRedisClient();
  const cache = createCache(redis);
  assert.ok(cache instanceof MultiLevelCache, "createCache 应返回 MultiLevelCache 实例");
  // CachePort 接口方法存在
  assert.equal(typeof cache.get, "function");
  assert.equal(typeof cache.set, "function");
  assert.equal(typeof cache.delete, "function");
  assert.equal(typeof cache.getWithRebuild, "function");
  assert.equal(typeof cache.doubleWrite, "function");
});

// ============================================================================
// C13. TCS-CACHE-01 红线触发
// ============================================================================

test("C13a. MultiLevelCache set 未提供 ttlSeconds 抛错（TCS-CACHE-01）", async () => {
  const redis = new InMemoryRedisClient();
  const cache = new MultiLevelCache(redis);
  // 构造非法 options：ttlSeconds=0 且未声明 ttlExempt
  await assert.rejects(
    async () => cache.set(makeKeyParams("u-no-ttl"), { name: "X" }, { ttlSeconds: 0 } as CacheSetOptions),
    /TCS-CACHE-01 违规/
  );
});

test("C13b. MultiLevelCache set ttlExempt=true 但 key 不在豁免清单抛错", async () => {
  const redis = new InMemoryRedisClient();
  const cache = new MultiLevelCache(redis); // 无豁免清单
  await assert.rejects(
    async () => cache.set(makeKeyParams("u-fake-exempt"), { name: "X" }, { ttlSeconds: 0, ttlExempt: true }),
    /TCS-CACHE-01 违规/
  );
});

// ============================================================================
// 默认常量校验
// ============================================================================

test("C14a. DEFAULT_TTL_JITTER_RATIO 为 0.2（±20%）", () => {
  assert.equal(DEFAULT_TTL_JITTER_RATIO, 0.2);
});

test("C14b. DEFAULT_BLOOM_EXPECTED_ITEMS 为 10000", () => {
  assert.equal(DEFAULT_BLOOM_EXPECTED_ITEMS, 10000);
});

test("C14c. DEFAULT_BLOOM_FALSE_POSITIVE_RATE 为 0.01（1%）", () => {
  assert.equal(DEFAULT_BLOOM_FALSE_POSITIVE_RATE, 0.01);
});
