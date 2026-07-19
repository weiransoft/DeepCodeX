/**
 * Fixture: E4 domain 层 import infrastructure 层（违规样例）
 *
 * @fixtureId import-analyzer/e4-domain-imports-infra.violation
 * @checker ImportAnalyzer
 * @redlineIds E4
 * @kind violation
 * @expectVerdict violated
 * @description domain 层文件 OrderService.ts import infrastructure 层模块 OrderRepositoryImpl——违反 E4 依赖方向红线
 */

// 该 export 的 artifacts 数组即 StaticChecker.check() 的入参
export const artifacts: ReadonlyArray<{ readonly path: string; readonly content: string }> = Object.freeze([
  {
    path: "src/domain/order/OrderService.ts",
    content: `// src/domain/order/OrderService.ts
import { OrderAggregate } from "./OrderAggregate";
// 违规点：domain 层 import infrastructure 层模块
import { OrderRepositoryImpl } from "../infrastructure/OrderRepositoryImpl";

/**
 * 订单领域服务
 */
export class OrderService {
  private orderRepository: OrderRepositoryImpl;

  constructor() {
    this.orderRepository = new OrderRepositoryImpl();
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
