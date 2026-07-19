/**
 * Fixture: TCS-CACHE-02 缓存与 DB 双写顺序错误（违规样例）
 *
 * @fixtureId cache-pattern-checker/tcs-cache-02-wrong-order.violation
 * @checker CachePatternChecker
 * @redlineIds TCS-CACHE-02
 * @kind violation
 * @expectVerdict violated
 * @description 先 cache.delete(key) 后 repository.save(order)——违反 TCS-CACHE-02 双写顺序红线
 */

// 该 export 的 artifacts 数组即 StaticChecker.check() 的入参
export const artifacts: ReadonlyArray<{ readonly path: string; readonly content: string }> = Object.freeze([
  {
    path: "src/application/order/OrderService.ts",
    content: `// src/application/order/OrderService.ts
import { CacheClient } from "../../infrastructure/cache/CacheClient";
import { OrderRepository } from "../../domain/order/OrderRepository";

/**
 * 订单应用服务——违规点：双写顺序错误（先删缓存后写 DB）
 */
export class OrderService {
  constructor(
    private readonly cache: CacheClient,
    private readonly repository: OrderRepository
  ) {}

  /**
   * 更新订单——违规点：先删除缓存再更新数据库
   */
  async updateOrder(orderId: string, order: Order): Promise<void> {
    const key = \`order:\${orderId}\`;
    // 违规点：先 cache.delete 后 repository.save（错误顺序）
    await this.cache.delete(key);
    await this.repository.save(order);
  }
}

interface Order {
  id: string;
  status: string;
  total: number;
}
`,
  },
]);
