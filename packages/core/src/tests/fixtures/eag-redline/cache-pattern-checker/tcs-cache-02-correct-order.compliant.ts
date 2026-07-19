/**
 * Fixture: TCS-CACHE-02 缓存与 DB 双写顺序正确（合规样例）
 *
 * @fixtureId cache-pattern-checker/tcs-cache-02-correct-order.compliant
 * @checker CachePatternChecker
 * @redlineIds TCS-CACHE-02
 * @kind compliant
 * @expectVerdict passed
 * @description 先 repository.save(order) 后 cache.delete(key)——Cache-Aside 正确顺序，符合 TCS-CACHE-02 红线
 */

// 该 export 的 artifacts 数组即 StaticChecker.check() 的入参
export const artifacts: ReadonlyArray<{ readonly path: string; readonly content: string }> = Object.freeze([
  {
    path: "src/application/order/OrderService.ts",
    content: `// src/application/order/OrderService.ts
import { CacheClient } from "../../infrastructure/cache/CacheClient";
import { OrderRepository } from "../../domain/order/OrderRepository";

/**
 * 订单应用服务——合规点：双写顺序正确（先写 DB 后删缓存）
 */
export class OrderService {
  constructor(
    private readonly cache: CacheClient,
    private readonly repository: OrderRepository
  ) {}

  /**
   * 更新订单——合规点：先更新数据库再删除缓存
   */
  async updateOrder(orderId: string, order: Order): Promise<void> {
    const key = \`order:\${orderId}\`;
    // 合规点：先 repository.save 后 cache.delete（Cache-Aside 正确顺序）
    await this.repository.save(order);
    await this.cache.delete(key);
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
