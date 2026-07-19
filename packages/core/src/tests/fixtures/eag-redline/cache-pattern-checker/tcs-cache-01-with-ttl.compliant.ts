/**
 * Fixture: TCS-CACHE-01 缓存含 TTL（合规样例）
 *
 * @fixtureId cache-pattern-checker/tcs-cache-01-with-ttl.compliant
 * @checker CachePatternChecker
 * @redlineIds TCS-CACHE-01
 * @kind compliant
 * @expectVerdict passed
 * @description cache.set(key, value, { ttlSeconds: 300 }) 显式提供 TTL——符合 TCS-CACHE-01 缓存 TTL 红线
 */

// 该 export 的 artifacts 数组即 StaticChecker.check() 的入参
export const artifacts: ReadonlyArray<{ readonly path: string; readonly content: string }> = Object.freeze([
  {
    path: "src/infrastructure/cache/UserCacheService.ts",
    content: `// src/infrastructure/cache/UserCacheService.ts
import { CacheClient } from "./CacheClient";

/**
 * 用户缓存服务——合规点：cache.set 显式提供 TTL
 */
export class UserCacheService {
  constructor(private readonly cache: CacheClient) {}

  /**
   * 缓存用户信息——合规点：显式设置 TTL
   */
  async cacheUser(userId: string, user: User): Promise<void> {
    const key = "user:" + userId;
    // 合规点：cache.set 调用显式提供 ttlSeconds 参数
    await this.cache.set(key, JSON.stringify(user), { ttlSeconds: 300 });
  }
}

interface User {
  id: string;
  username: string;
  email: string;
}
`,
  },
]);
