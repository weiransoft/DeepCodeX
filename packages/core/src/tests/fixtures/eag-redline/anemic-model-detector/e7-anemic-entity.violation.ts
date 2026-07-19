/**
 * Fixture: E7 贫血模型（违规样例）
 *
 * @fixtureId anemic-model-detector/e7-anemic-entity.violation
 * @checker AnemicModelDetector
 * @redlineIds E7
 * @kind violation
 * @expectVerdict violated
 * @description OrderAggregate 仅有 getter/setter，业务方法 0 个——疑似贫血模型，违反 E7 红线
 */

// 该 export 的 artifacts 数组即 StaticChecker.check() 的入参
export const artifacts: ReadonlyArray<{ readonly path: string; readonly content: string }> = Object.freeze([
  {
    path: "src/domain/order/OrderAggregate.ts",
    content: `// src/domain/order/OrderAggregate.ts
/**
 * 订单聚合根——违规点：贫血模型（仅有 getter/setter，无业务方法）
 */
export class OrderAggregate {
  private orderId: string;
  private status: string;
  private total: number;

  constructor(orderId: string) {
    this.orderId = orderId;
    this.status = "pending";
    this.total = 0;
  }

  // 违规点：仅有 getter/setter，无业务方法
  getOrderId(): string {
    return this.orderId;
  }

  getStatus(): string {
    return this.status;
  }

  setStatus(status: string): void {
    this.status = status;
  }

  getTotal(): number {
    return this.total;
  }

  setTotal(total: number): void {
    this.total = total;
  }
}
`,
  },
]);
