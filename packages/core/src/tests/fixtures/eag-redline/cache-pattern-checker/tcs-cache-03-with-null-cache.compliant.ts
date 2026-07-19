/**
 * Fixture: TCS-CACHE-03 缓存穿透防护（合规样例）
 *
 * @fixtureId cache-pattern-checker/tcs-cache-03-with-null-cache.compliant
 * @checker CachePatternChecker
 * @redlineIds TCS-CACHE-03
 * @kind compliant
 * @expectVerdict passed
 * @description cache.get 返回 null → 查 DB → 无记录时缓存 NULL_SENTINEL——防穿透合规，符合 TCS-CACHE-03 红线
 */

// 该 export 的 artifacts 数组即 StaticChecker.check() 的入参
export const artifacts: ReadonlyArray<{ readonly path: string; readonly content: string }> = Object.freeze([
  {
    path: "src/application/user/UserQueryService.ts",
    content: `// src/application/user/UserQueryService.ts
import { CacheClient } from "../../infrastructure/cache/CacheClient";
import { UserRepository } from "../../domain/user/UserRepository";

/**
 * 空值缓存标记
 */
const NULL_SENTINEL = "__NULL__";

/**
 * 用户查询服务——合规点：缓存穿透防护（空值缓存）
 */
export class UserQueryService {
  constructor(
    private readonly cache: CacheClient,
    private readonly repository: UserRepository
  ) {}

  /**
   * 查询用户——合规点：缓存未命中后缓存空值
   */
  async getUser(userId: string): Promise<User | null> {
    const key = \`user:\${userId}\`;
    // 先查缓存
    const cached = await this.cache.get(key);
    if (cached === NULL_SENTINEL) {
      // 合规点：命中空值缓存，直接返回 null
      return null;
    }
    if (cached) {
      return JSON.parse(cached);
    }
    // 缓存未命中，查数据库
    const user = await this.repository.findById(userId);
    if (!user) {
      // 合规点：数据库无记录，缓存空值防穿透
      await this.cache.set(key, NULL_SENTINEL, { ttlSeconds: 60 });
      return null;
    }
    // 缓存查询结果
    await this.cache.set(key, JSON.stringify(user), { ttlSeconds: 300 });
    return user;
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
