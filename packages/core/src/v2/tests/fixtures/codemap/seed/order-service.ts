/**
 * CodeMap 性能基准测试种子文件 - 订单服务
 *
 * 与 user-service 形成依赖关系：order-service → user-service
 */

import type { UserService } from "./user-service";

export class OrderService {
  constructor(private userService: UserService) {}

  createOrder(userId: string, items: OrderItem[]): Order {
    const user = this.userService.getUser(userId);
    if (!user) {
      throw new Error(`User not found: ${userId}`);
    }
    return {
      id: `order-${Date.now()}`,
      userId,
      items,
      total: items.reduce((sum, item) => sum + item.price * item.quantity, 0),
      createdAt: new Date().toISOString(),
    };
  }

  listUserOrders(_userId: string): Order[] {
    // 性能基准种子文件：仅用于 CodeMap 依赖图生成，不实现真实查询逻辑
    return [];
  }
}

export interface OrderItem {
  productId: string;
  quantity: number;
  price: number;
}

export interface Order {
  id: string;
  userId: string;
  items: OrderItem[];
  total: number;
  createdAt: string;
}
