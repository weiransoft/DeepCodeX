/**
 * Fixture: E1 跨聚合写操作通过 Saga 编排（合规样例）
 *
 * @fixtureId saga-detector/e1-saga-orchestrator.compliant
 * @checker SagaDetector
 * @redlineIds E1
 * @kind compliant
 * @expectVerdict passed
 * @description 聚合根仅修改自身状态并发布领域事件，跨聚合一致性由 OrderSagaOrchestrator 编排——符合 E1 事务边界红线
 */

// 该 export 的 artifacts 数组即 StaticChecker.check() 的入参
export const artifacts: ReadonlyArray<{ readonly path: string; readonly content: string }> = Object.freeze([
  {
    path: "src/domain/order/OrderAggregate.ts",
    content: `// src/domain/order/OrderAggregate.ts
/**
 * 订单聚合根
 */
export class OrderAggregate {
  private status: string = "pending";
  private domainEvents: Array<object> = [];

  /**
   * 确认订单——仅修改自身状态并发布事件，符合 E1
   */
  confirm(): void {
    this.status = "confirmed";
    // 合规点：仅发布领域事件，不直接跨聚合写
    this.publish(new OrderConfirmedEvent(this.status));
  }

  private publish(event: object): void {
    this.domainEvents.push(event);
  }

  getStatus(): string {
    return this.status;
  }
}

class OrderConfirmedEvent {
  constructor(public readonly status: string) {}
}
`,
  },
  {
    path: "src/domain/inventory/InventoryAggregate.ts",
    content: `// src/domain/inventory/InventoryAggregate.ts
/**
 * 库存聚合根
 */
export class InventoryAggregate {
  private stock: number = 0;

  updateStock(quantity: number): void {
    this.stock -= quantity;
  }

  getStock(): number {
    return this.stock;
  }
}
`,
  },
  {
    path: "src/application/order/OrderSagaOrchestrator.ts",
    content: `// src/application/order/OrderSagaOrchestrator.ts
/**
 * 订单 Saga 编排器——负责跨聚合一致性
 */
export class OrderSagaOrchestrator {
  constructor(
    private readonly orderAggregate: OrderAggregate,
    private readonly inventoryAggregate: InventoryAggregate
  ) {}

  /**
   * 处理订单确认事件——编排跨聚合写操作
   */
  async handleOrderConfirmed(event: OrderConfirmedEvent): Promise<void> {
    // 合规点：跨聚合写由 Saga 编排器协调，而非聚合根直接调用
    await this.inventoryAggregate.updateStock(1);
  }
}

import { OrderAggregate } from "../../domain/order/OrderAggregate";
import { InventoryAggregate } from "../../domain/inventory/InventoryAggregate";
import { OrderConfirmedEvent } from "../../domain/order/OrderAggregate";
`,
  },
]);
