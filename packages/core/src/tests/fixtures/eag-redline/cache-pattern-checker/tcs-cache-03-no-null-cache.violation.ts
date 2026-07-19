/**
 * Fixture: TCS-CACHE-03 缓存穿透无防护（违规样例）
 *
 * @fixtureId cache-pattern-checker/tcs-cache-03-no-null-cache.violation
 * @checker CachePatternChecker
 * @redlineIds TCS-CACHE-03
 * @kind violation
 * @expectVerdict violated
 * @description cache.get 返回 null → 查 DB → 无记录直接 return null，不缓存空值——违反 TCS-CACHE-03 缓存穿透红线
 */

// 该 export 的 artifacts 数组即 StaticChecker.check() 的入参
export const artifacts: ReadonlyArray<{ readonly path: string; readonly content: string }> = Object.freeze([
  {
    path: "src/application/user/UserQueryService.ts",
    content: `// src/application/user/UserQueryService.ts
import { CacheClient } from "../../infrastructure/cache/CacheClient";
import { UserRepository } from "../../domain/user/UserRepository";

/**
 * 用户查询服务——违规点：缓存穿透无防护
 */
export class UserQueryService {
  constructor(
    private readonly cache: CacheClient,
    private readonly repository: UserRepository
  ) {}

  /**
   * 查询用户——违规点：缓存未命中后未缓存空值
   */
  async getUser(userId: string): Promise<User | null> {
    const key = "user:" + userId;
    // 先查缓存
    const cached = await this.cache.get(key);
    if (cached) {
      return JSON.parse(cached);
    }
    // 缓存未命中，查数据库
    const user = await this.repository.findById(userId);
    if (!user) {
      // 违规点：数据库无记录时直接返回 null，未缓存空值，恶意请求会穿透缓存打到 DB
      return null;
    }
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
