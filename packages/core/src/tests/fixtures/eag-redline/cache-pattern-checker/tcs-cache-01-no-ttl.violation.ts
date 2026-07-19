/**
 * Fixture: TCS-CACHE-01 缓存无 TTL（违规样例）
 *
 * @fixtureId cache-pattern-checker/tcs-cache-01-no-ttl.violation
 * @checker CachePatternChecker
 * @redlineIds TCS-CACHE-01
 * @kind violation
 * @expectVerdict violated
 * @description cache.set(key, value) 无第三参数 TTL——违反 TCS-CACHE-01 缓存无 TTL 红线
 */

// 该 export 的 artifacts 数组即 StaticChecker.check() 的入参
export const artifacts: ReadonlyArray<{ readonly path: string; readonly content: string }> = Object.freeze([
  {
    path: "src/infrastructure/cache/UserCacheService.ts",
    content: `// src/infrastructure/cache/UserCacheService.ts
import { CacheClient } from "./CacheClient";

/**
 * 用户缓存服务——违规点：cache.set 无 TTL 参数
 */
export class UserCacheService {
  constructor(private readonly cache: CacheClient) {}

  /**
   * 缓存用户信息——违规点：未设置 TTL
   */
  async cacheUser(userId: string, user: User): Promise<void> {
    const key = \`user:\${userId}\`;
    // 违规点：cache.set 调用无第三参数 TTL
    await this.cache.set(key, JSON.stringify(user));
  }

  /**
   * 获取缓存用户
   */
  async getUser(userId: string): Promise<User | null> {
    const key = \`user:\${userId}\`;
    const cached = await this.cache.get(key);
    return cached ? JSON.parse(cached) : null;
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
