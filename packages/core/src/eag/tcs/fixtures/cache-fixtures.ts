/**
 * TCS 缓存红线 fixtures（TCS-CACHE-01 / TCS-CACHE-02 / TCS-CACHE-03）
 *
 * 每条红线 1 个违规样例 + 1 个合规样例（共 6 个 fixture），
 * 用于测试评估器对缓存红线的判定准确性。
 *
 * 设计依据：
 * - EAG 方案 §5.8.2 缓存规范（多级缓存 + 三防设计）
 * - eag/tcs/cache.ts（MultiLevelCache + CachePort）
 * - eag/tcs/tcs-redlines.ts（TCS-CACHE-01/02/03 红线定义）
 *
 * @module eag/tcs/fixtures/cache-fixtures
 */

// 引入 deepFreeze 用于递归冻结 fixture 及其嵌套的 expectedViolations 数组。
// Object.freeze 是浅冻结，无法冻结嵌套的 expectedViolations 数组本身——
// F12 测试断言 Object.isFrozen(f.expectedViolations) 必须为 true，
// 因此改用 deepFreeze（types.ts 中已实现）递归冻结所有层级。
import { deepFreeze, type RedlineFixture } from "../types";

// ============================================================================
// TCS-CACHE-01：缓存无 TTL
// ============================================================================

/**
 * TCS-CACHE-01 违规样例：缓存写入未设置 TTL
 *
 * 场景：业务代码调用 cache.set(key, value, { ttlSeconds: 0 })，
 * TTL=0 导致 key 永久缓存，Redis 内存无限增长最终 OOM。
 */
export const CACHE_01_VIOLATION: RedlineFixture = deepFreeze({
  redlineId: "TCS-CACHE-01",
  kind: "violation",
  description:
    "业务代码（user-cache.ts）调用 cache.set() 写入用户信息时未提供 ttlSeconds（或设置为 0），" +
    "且未声明 ttlExempt=true 加入豁免清单。导致 key 永久缓存，Redis 内存无限增长最终 OOM，" +
    "且数据更新后缓存不会自动失效，长期与 DB 不一致。",
  code: [
    "// src/services/user-cache.ts",
    "import type { CachePort, CacheKeyParams } from '../eag/tcs/cache';",
    "",
    "export class UserCacheService {",
    "  constructor(private readonly cache: CachePort) {}",
    "",
    "  /** 缓存用户信息（违规：未设置 TTL） */",
    "  async cacheUser(userId: string, userInfo: UserInfo): Promise<void> {",
    "    const keyParams: CacheKeyParams = {",
    "      app: 'hongene',",
    "      domain: 'user',",
    "      entity: 'profile',",
    "      id: userId,",
    "    };",
    "    // 违规：未提供 ttlSeconds，且未声明 ttlExempt",
    "    await this.cache.set(keyParams, userInfo, {",
    "      // ttlSeconds 缺失",
    "    });",
    "  }",
    "}",
  ].join("\n"),
  language: "typescript",
  expectedViolations: [
    {
      filePath: "src/services/user-cache.ts",
      line: 17,
      description:
        "cache.set() 调用未提供 ttlSeconds（或 ≤0），且未声明 ttlExempt=true 加入豁免清单，违反 TCS-CACHE-01 红线",
    },
  ],
  expectedVerdict: "violated",
});

/**
 * TCS-CACHE-01 合规样例：缓存写入显式设置 TTL
 *
 * 场景：业务代码调用 cache.set(key, value, { ttlSeconds: 300 })，
 * 5 分钟过期，符合规范。
 */
export const CACHE_01_COMPLIANT: RedlineFixture = deepFreeze({
  redlineId: "TCS-CACHE-01",
  kind: "compliant",
  description:
    "业务代码（user-cache.ts）调用 cache.set() 写入用户信息时显式提供 ttlSeconds=300（5 分钟），" +
    "对齐 §5.8.2 规范——所有缓存 key 必须显式 TTL。",
  code: [
    "// src/services/user-cache.ts",
    "import type { CachePort, CacheKeyParams } from '../eag/tcs/cache';",
    "",
    "export class UserCacheService {",
    "  constructor(private readonly cache: CachePort) {}",
    "",
    "  /** 缓存用户信息（合规：5 分钟 TTL） */",
    "  async cacheUser(userId: string, userInfo: UserInfo): Promise<void> {",
    "    const keyParams: CacheKeyParams = {",
    "      app: 'hongene',",
    "      domain: 'user',",
    "      entity: 'profile',",
    "      id: userId,",
    "    };",
    "    // 合规：显式设置 5 分钟 TTL",
    "    await this.cache.set(keyParams, userInfo, {",
    "      ttlSeconds: 300,",
    "    });",
    "  }",
    "}",
  ].join("\n"),
  language: "typescript",
  expectedViolations: [],
  expectedVerdict: "passed",
});

// ============================================================================
// TCS-CACHE-02：缓存与 DB 双写顺序错误
// ============================================================================

/**
 * TCS-CACHE-02 违规样例：先删缓存后更库（顺序错误）
 *
 * 场景：业务代码先调用 cache.delete() 删除缓存，再调用 db.update() 更新数据库。
 * 并发场景下另一线程读取缓存未命中从 DB 加载旧值回填，导致缓存与 DB 长期不一致。
 */
export const CACHE_02_VIOLATION: RedlineFixture = deepFreeze({
  redlineId: "TCS-CACHE-02",
  kind: "violation",
  description:
    "业务代码（user-update.ts）手动实现双写，先调用 cache.delete() 删除缓存，" +
    "再调用 db.update() 更新数据库。违反 §5.8.2「先更库后删缓存」红线——" +
    "并发场景下另一线程读取缓存未命中从 DB 加载旧值回填，导致缓存为旧值、DB 为新值，长期不一致。",
  code: [
    "// src/services/user-update.ts",
    "import type { CachePort, CacheKeyParams } from '../eag/tcs/cache';",
    "import type { UserRepository } from '../repositories/user-repo';",
    "",
    "export class UserUpdateService {",
    "  constructor(",
    "    private readonly cache: CachePort,",
    "    private readonly userRepo: UserRepository,",
    "  ) {}",
    "",
    "  /** 更新用户信息（违规：先删缓存后更库） */",
    "  async updateUser(userId: string, updates: Partial<User>): Promise<void> {",
    "    const keyParams: CacheKeyParams = {",
    "      app: 'hongene',",
    "      domain: 'user',",
    "      entity: 'profile',",
    "      id: userId,",
    "    };",
    "    // 违规：先删缓存",
    "    await this.cache.delete(keyParams);",
    "    // 违规：后更库（顺序错误，并发下会导致不一致）",
    "    await this.userRepo.update(userId, updates);",
    "  }",
    "}",
  ].join("\n"),
  language: "typescript",
  expectedViolations: [
    {
      filePath: "src/services/user-update.ts",
      line: 20,
      description:
        "cache.delete() 在 db.update() 之前——违反 TCS-CACHE-02 红线「先更库后删缓存」顺序，应改用 port.doubleWrite() 委托",
    },
  ],
  expectedVerdict: "violated",
});

/**
 * TCS-CACHE-02 合规样例：通过 port.doubleWrite 委托双写
 *
 * 场景：业务代码调用 cache.doubleWrite(key, dbUpdater) 委托 CachePort 处理双写顺序，
 * CachePort 内部强制「先更库后删缓存」顺序，业务代码无需感知顺序问题。
 */
export const CACHE_02_COMPLIANT: RedlineFixture = deepFreeze({
  redlineId: "TCS-CACHE-02",
  kind: "compliant",
  description:
    "业务代码（user-update.ts）通过 cache.doubleWrite(key, dbUpdater) 委托 CachePort 处理双写顺序，" +
    "CachePort 内部强制「先更库后删缓存」顺序，业务代码无需感知顺序问题，符合 §5.8.2 规范。",
  code: [
    "// src/services/user-update.ts",
    "import type { CachePort, CacheKeyParams } from '../eag/tcs/cache';",
    "import type { UserRepository } from '../repositories/user-repo';",
    "",
    "export class UserUpdateService {",
    "  constructor(",
    "    private readonly cache: CachePort,",
    "    private readonly userRepo: UserRepository,",
    "  ) {}",
    "",
    "  /** 更新用户信息（合规：通过 doubleWrite 委托双写顺序） */",
    "  async updateUser(userId: string, updates: Partial<User>): Promise<void> {",
    "    const keyParams: CacheKeyParams = {",
    "      app: 'hongene',",
    "      domain: 'user',",
    "      entity: 'profile',",
    "      id: userId,",
    "    };",
    "    // 合规：通过 doubleWrite 委托 CachePort 强制「先更库后删缓存」",
    "    await this.cache.doubleWrite(keyParams, async () => {",
    "      await this.userRepo.update(userId, updates);",
    "    });",
    "  }",
    "}",
  ].join("\n"),
  language: "typescript",
  expectedViolations: [],
  expectedVerdict: "passed",
});

// ============================================================================
// TCS-CACHE-03：缓存穿透无防护
// ============================================================================

/**
 * TCS-CACHE-03 违规样例：缓存未命中直接透传到 DB
 *
 * 场景：业务代码先调用 cache.get()，未命中时直接调用 db.query() 加载数据，
 * 未启用空值缓存（nullCache）或布隆过滤器。攻击者查询大量不存在的 key 时所有查询透传到 DB，
 * DB 负载激增最终崩溃。
 */
export const CACHE_03_VIOLATION: RedlineFixture = deepFreeze({
  redlineId: "TCS-CACHE-03",
  kind: "violation",
  description:
    "业务代码（product-query.ts）先调用 cache.get() 查询缓存，未命中时直接调用 db.query() 加载数据，" +
    "未启用空值缓存（nullCache）或布隆过滤器防护穿透。攻击者查询大量不存在的商品 ID 时，" +
    "所有查询透传到 DB，DB 负载激增最终崩溃。",
  code: [
    "// src/services/product-query.ts",
    "import type { CachePort, CacheKeyParams } from '../eag/tcs/cache';",
    "import type { ProductRepository } from '../repositories/product-repo';",
    "",
    "export class ProductQueryService {",
    "  constructor(",
    "    private readonly cache: CachePort,",
    "    private readonly productRepo: ProductRepository,",
    "  ) {}",
    "",
    "  /** 查询商品（违规：未启用穿透防护） */",
    "  async getProduct(productId: string): Promise<Product | null> {",
    "    const keyParams: CacheKeyParams = {",
    "      app: 'hongene',",
    "      domain: 'product',",
    "      entity: 'detail',",
    "      id: productId,",
    "    };",
    "    // 直接调用 cache.get + db.query，无穿透防护",
    "    const cached = await this.cache.get<Product>(keyParams);",
    "    if (cached.hit) {",
    "      return cached.value;",
    "    }",
    "    // 违规：缓存未命中直接查询 DB，未启用空值缓存或布隆过滤器",
    "    const product = await this.productRepo.findById(productId);",
    "    if (product) {",
    "      await this.cache.set(keyParams, product, { ttlSeconds: 300 });",
    "    }",
    "    return product;",
    "  }",
    "}",
  ].join("\n"),
  language: "typescript",
  expectedViolations: [
    {
      filePath: "src/services/product-query.ts",
      line: 22,
      description:
        "cache.get() 未命中时直接调用 db.query()，未启用 nullCache（空值缓存）或布隆过滤器，违反 TCS-CACHE-03 红线",
    },
  ],
  expectedVerdict: "violated",
});

/**
 * TCS-CACHE-03 合规样例：通过 getWithRebuild 启用空值缓存防护
 *
 * 场景：业务代码调用 cache.getWithRebuild(key, loader, { ttlSeconds, nullCache: true })，
 * 启用空值缓存——查询 DB 返回 null 时也写入缓存（短 TTL），防止攻击者重复查询不存在的 key 透传到 DB。
 */
export const CACHE_03_COMPLIANT: RedlineFixture = deepFreeze({
  redlineId: "TCS-CACHE-03",
  kind: "compliant",
  description:
    "业务代码（product-query.ts）调用 cache.getWithRebuild(key, loader, { ttlSeconds, nullCache: true })，" +
    "启用空值缓存——查询 DB 返回 null 时也写入缓存（短 TTL），防止攻击者重复查询不存在的 key 透传到 DB，" +
    "符合 §5.8.2 规范。",
  code: [
    "// src/services/product-query.ts",
    "import type { CachePort, CacheKeyParams } from '../eag/tcs/cache';",
    "import type { ProductRepository } from '../repositories/product-repo';",
    "",
    "export class ProductQueryService {",
    "  constructor(",
    "    private readonly cache: CachePort,",
    "    private readonly productRepo: ProductRepository,",
    "  ) {}",
    "",
    "  /** 查询商品（合规：getWithRebuild + nullCache 穿透防护） */",
    "  async getProduct(productId: string): Promise<Product | null> {",
    "    const keyParams: CacheKeyParams = {",
    "      app: 'hongene',",
    "      domain: 'product',",
    "      entity: 'detail',",
    "      id: productId,",
    "    };",
    "    // 合规：getWithRebuild 启用空值缓存（nullCache: true）",
    "    const result = await this.cache.getWithRebuild<Product>(",
    "      keyParams,",
    "      async () => this.productRepo.findById(productId),",
    "      {",
    "        ttlSeconds: 300,",
    "        nullCache: true, // 启用空值缓存防护穿透",
    "      },",
    "    );",
    "    return result.value;",
    "  }",
    "}",
  ].join("\n"),
  language: "typescript",
  expectedViolations: [],
  expectedVerdict: "passed",
});

// ============================================================================
// 缓存 fixtures 聚合导出
// ============================================================================

/**
 * 缓存全部 fixtures（6 个，TCS-CACHE-01/02/03 各 2 个）
 */
export const CACHE_FIXTURES: ReadonlyArray<RedlineFixture> = Object.freeze([
  CACHE_01_VIOLATION,
  CACHE_01_COMPLIANT,
  CACHE_02_VIOLATION,
  CACHE_02_COMPLIANT,
  CACHE_03_VIOLATION,
  CACHE_03_COMPLIANT,
]);
