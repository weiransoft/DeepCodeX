/**
 * Fixture: E2 写接口无幂等键参数（违规样例）
 *
 * @fixtureId idempotency-checker/e2-no-idempotency-key.violation
 * @checker IdempotencyChecker
 * @redlineIds E2
 * @kind violation
 * @expectVerdict violated
 * @description Controller @Post 方法无 Idempotency-Key 参数 + 事件处理器无去重表——违反 E2 幂等性红线
 */

// 该 export 的 artifacts 数组即 StaticChecker.check() 的入参
export const artifacts: ReadonlyArray<{ readonly path: string; readonly content: string }> = Object.freeze([
  {
    path: "src/interfaces/order/controllers/OrderController.ts",
    content: `// src/interfaces/order/controllers/OrderController.ts
import { Controller, Post, Body } from "@nestjs/common";

/**
 * 订单控制器
 */
@Controller("orders")
export class OrderController {
  /**
   * 创建订单——无幂等键参数，违反 E2
   */
  @Post()
  async createOrder(@Body() createOrderDto: CreateOrderDto): Promise<OrderResponse> {
    // 违规点：@Post 方法参数列表未声明幂等键请求头，网络重试时会产生重复下单
    return this.orderService.create(createOrderDto);
  }
}

interface CreateOrderDto {
  userId: string;
  items: Array<{ productId: string; quantity: number }>;
}

interface OrderResponse {
  orderId: string;
  status: string;
}
`,
  },
  {
    path: "src/application/order/event-handlers/OrderEventHandler.ts",
    content: `// src/application/order/event-handlers/OrderEventHandler.ts
import { EventHandler } from "@nestjs/cqrs";

/**
 * 订单事件处理器——无幂等去重保护，违反 E2
 */
@EventHandler(OrderCreatedEvent)
export class OrderEventHandler {
  /**
   * 处理订单创建事件——无幂等去重保护
   */
  async handle(event: OrderCreatedEvent): Promise<void> {
    // 违规点：事件处理器未做任何幂等去重保护，重复消费消息时会产生重复写入
    await this.orderRepository.save(event.order);
  }
}

class OrderCreatedEvent {
  constructor(public readonly order: object) {}
}
`,
  },
]);
