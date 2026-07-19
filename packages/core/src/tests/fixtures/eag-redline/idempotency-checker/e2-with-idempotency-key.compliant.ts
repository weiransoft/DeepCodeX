/**
 * Fixture: E2 写接口含幂等键参数（合规样例）
 *
 * @fixtureId idempotency-checker/e2-with-idempotency-key.compliant
 * @checker IdempotencyChecker
 * @redlineIds E2
 * @kind compliant
 * @expectVerdict passed
 * @description @Post 方法含 @Headers('Idempotency-Key') + 事件处理器使用 SETNX 去重——符合 E2 幂等性红线
 */

// 该 export 的 artifacts 数组即 StaticChecker.check() 的入参
export const artifacts: ReadonlyArray<{ readonly path: string; readonly content: string }> = Object.freeze([
  {
    path: "src/interfaces/order/controllers/OrderController.ts",
    content: `// src/interfaces/order/controllers/OrderController.ts
import { Controller, Post, Body, Headers } from "@nestjs/common";

/**
 * 订单控制器
 */
@Controller("orders")
export class OrderController {
  /**
   * 创建订单——含幂等键参数，符合 E2
   */
  @Post()
  async createOrder(
    @Body() createOrderDto: CreateOrderDto,
    @Headers("Idempotency-Key") idempotencyKey: string
  ): Promise<OrderResponse> {
    // 合规点：@Post 方法参数含 Idempotency-Key
    return this.orderService.create(createOrderDto, idempotencyKey);
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
import { RedisClient } from "../../infrastructure/redis/RedisClient";

/**
 * 订单事件处理器——使用 SETNX 幂等去重，符合 E2
 */
@EventHandler(OrderCreatedEvent)
export class OrderEventHandler {
  constructor(private readonly redis: RedisClient) {}

  /**
   * 处理订单创建事件——使用 Redis SETNX 去重保护
   */
  async handle(event: OrderCreatedEvent): Promise<void> {
    // 合规点：事件处理器使用 SETNX 幂等保护
    const key = \`order:event:\${event.orderId}\`;
    const isNew = await this.redis.setnx(key, "1");
    if (isNew === 0) {
      // 已处理过，直接返回
      return;
    }
    await this.orderRepository.save(event.order);
  }
}

class OrderCreatedEvent {
  constructor(public readonly orderId: string, public readonly order: object) {}
}
`,
  },
]);
