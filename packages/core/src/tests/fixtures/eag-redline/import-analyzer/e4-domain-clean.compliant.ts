/**
 * Fixture: E4 domain 层仅 import 同层模块（合规样例）
 *
 * @fixtureId import-analyzer/e4-domain-clean.compliant
 * @checker ImportAnalyzer
 * @redlineIds E4
 * @kind compliant
 * @expectVerdict passed
 * @description domain 层文件 OrderService.ts 仅 import 同层模块与 Port 接口——符合 E4 依赖方向红线
 */

// 该 export 的 artifacts 数组即 StaticChecker.check() 的入参
export const artifacts: ReadonlyArray<{ readonly path: string; readonly content: string }> = Object.freeze([
  {
    path: "src/domain/order/OrderService.ts",
    content: `// src/domain/order/OrderService.ts
import { OrderAggregate } from "./OrderAggregate";
// 合规点：仅 import 同层 Port 接口（类型导入）
import type { OrderRepositoryPort } from "./OrderRepositoryPort";

/**
 * 订单领域服务
 */
export class OrderService {
  private orderRepository: OrderRepositoryPort;

  constructor(orderRepository: OrderRepositoryPort) {
    this.orderRepository = orderRepository;
  }

  /**
   * 创建订单
   */
  async createOrder(orderId: string, userId: string): Promise<OrderAggregate> {
    const order = new OrderAggregate(orderId, userId);
    await this.orderRepository.save(order);
    return order;
  }
}
`,
  },
]);
