/**
 * Fixture: E1 跨聚合写操作无 Saga 编排（违规样例）
 *
 * @fixtureId saga-detector/e1-cross-aggregate-write.violation
 * @checker SagaDetector
 * @redlineIds E1
 * @kind violation
 * @expectVerdict violated
 * @description 聚合根 OrderAggregate.confirm() 直接调用 InventoryAggregate 实例的写方法
 *              updateStock()，且代码库中不存在 Saga/Orchestrator 类——违反 E1 事务边界红线
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
  private inventoryAggregate: InventoryAggregate;

  constructor(inventoryAggregate: InventoryAggregate) {
    this.inventoryAggregate = inventoryAggregate;
  }

  /**
   * 确认订单——直接跨聚合写调用，违反 E1
   */
  confirm(quantity: number): void {
    this.status = "confirmed";
    // 违规点：直接调用另一聚合根的写方法（非 this），且无 Saga 编排
    this.inventoryAggregate.updateStock(quantity);
  }

  getStatus(): string {
    return this.status;
  }
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
]);
