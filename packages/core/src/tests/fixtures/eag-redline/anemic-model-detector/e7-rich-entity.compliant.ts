/**
 * Fixture: E7 充血模型（合规样例）
 *
 * @fixtureId anemic-model-detector/e7-rich-entity.compliant
 * @checker AnemicModelDetector
 * @redlineIds E7
 * @kind compliant
 * @expectVerdict passed
 * @description OrderAggregate 含 cancel / ship / applyDiscount 3 个业务方法，无 setter——符合 E7 充血模型红线
 */

// 该 export 的 artifacts 数组即 StaticChecker.check() 的入参
export const artifacts: ReadonlyArray<{ readonly path: string; readonly content: string }> = Object.freeze([
  {
    path: "src/domain/order/OrderAggregate.ts",
    content: `// src/domain/order/OrderAggregate.ts
/**
 * 订单聚合根——合规点：充血模型（含业务方法，无 setter）
 */
export class OrderAggregate {
  private orderId: string;
  private status: string;
  private total: number;
  private items: Array<{ productId: string; quantity: number; price: number }> = [];

  constructor(orderId: string) {
    this.orderId = orderId;
    this.status = "pending";
    this.total = 0;
  }

  /**
   * 取消订单——业务方法
   */
  cancel(reason: string): void {
    if (this.status === "shipped") {
      throw new Error("已发货订单不可取消");
    }
    this.status = "cancelled";
    // 发布订单取消事件
    this.publish(new OrderCancelledEvent(this.orderId, reason));
  }

  /**
   * 发货——业务方法
   */
  ship(address: string): void {
    if (this.status !== "confirmed") {
      throw new Error("订单未确认，不可发货");
    }
    this.status = "shipped";
    // 发布订单发货事件
    this.publish(new OrderShippedEvent(this.orderId, address));
  }

  /**
   * 应用折扣——业务方法
   */
  applyDiscount(rate: number): void {
    if (rate < 0 || rate > 1) {
      throw new Error("折扣率必须在 0~1 之间");
    }
    this.total = this.total * (1 - rate);
    // 发布折扣应用事件
    this.publish(new DiscountAppliedEvent(this.orderId, rate, this.total));
  }

  private publish(event: object): void {
    // 事件发布逻辑
  }

  getOrderId(): string {
    return this.orderId;
  }

  getStatus(): string {
    return this.status;
  }

  getTotal(): number {
    return this.total;
  }
}

class OrderCancelledEvent {
  constructor(public readonly orderId: string, public readonly reason: string) {}
}

class OrderShippedEvent {
  constructor(public readonly orderId: string, public readonly address: string) {}
}

class DiscountAppliedEvent {
  constructor(
    public readonly orderId: string,
    public readonly rate: number,
    public readonly newTotal: number
  ) {}
}
`,
  },
]);
