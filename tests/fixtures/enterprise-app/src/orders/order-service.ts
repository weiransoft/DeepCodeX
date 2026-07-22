/**
 * 订单管理服务
 * 负责订单的创建、查询和取消，联动商品和库存模块
 */

import { randomUUID } from "crypto";
import { Repository } from "../utils/repository.js";
import { NotFoundError, ValidationError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import type { ProductService } from "../products/product-service.js";
import type { InventoryService } from "../inventory/inventory-service.js";

/** 订单项 */
export interface OrderItem {
  productId: string;
  productName: string;
  price: number;
  quantity: number;
  subtotal: number;
}

/** 订单实体 */
export interface Order {
  id: string;
  items: OrderItem[];
  total: number;
  status: "pending" | "cancelled";
  createdAt: string;
}

/** 订单仓储 */
class OrderRepository extends Repository<Order> {}

export class OrderService {
  private repository: OrderRepository;
  private productService: ProductService;
  private inventoryService: InventoryService;

  constructor(productService: ProductService, inventoryService: InventoryService) {
    this.repository = new OrderRepository();
    this.productService = productService;
    this.inventoryService = inventoryService;
  }

  /**
   * 创建订单（事务：扣减库存 + 创建订单，失败回滚）
   * @param input - 订单输入数据
   * @returns 创建的订单对象
   * @throws ValidationError - 参数校验失败
   * @throws NotFoundError - 商品不存在
   * @throws InsufficientStockError - 库存不足
   */
  create(input: { items: Array<{ productId: string; quantity: number }> }): Order {
    // 校验 items 非空
    if (!input.items || input.items.length === 0) {
      throw new ValidationError("items", "must not be empty");
    }

    const orderItems: OrderItem[] = [];
    const deductedItems: Array<{ productId: string; quantity: number }> = [];

    try {
      // 第一步：验证所有商品存在，并构建订单项
      for (const item of input.items) {
        // 校验 quantity
        if (item.quantity <= 0) {
          throw new ValidationError("quantity", "must be > 0");
        }

        // 查询商品（INT-002）
        const product = this.productService.getById(item.productId);
        if (!product) {
          throw new NotFoundError("Product", item.productId);
        }

        // 构建订单项
        const orderItem: OrderItem = {
          productId: product.id,
          productName: product.name,
          price: product.price,
          quantity: item.quantity,
          subtotal: product.price * item.quantity,
        };
        orderItems.push(orderItem);
      }

      // 第二步：逐个扣减库存（INT-003）
      // v2.1.3 E2E 修复：移除内层 catch 中的回滚逻辑，由外层 catch 统一回滚
      // 原实现中内层 catch 回滚后抛出异常，外层 catch 再次回滚，导致库存被加回两次
      // （例如 p1 库存 100 → 扣减 5 → 95 → 内层回滚 5 → 100 → 外层回滚 5 → 105）
      for (const orderItem of orderItems) {
        this.inventoryService.deduct(orderItem.productId, orderItem.quantity);
        deductedItems.push({
          productId: orderItem.productId,
          quantity: orderItem.quantity,
        });
      }

      // 第三步：计算总价
      const total = orderItems.reduce((sum, item) => sum + item.subtotal, 0);

      // 第四步：创建订单记录
      const order: Order = {
        id: randomUUID(),
        items: orderItems,
        total,
        status: "pending",
        createdAt: new Date().toISOString(),
      };

      this.repository.save(order);

      logger.info("Order created", {
        orderId: order.id,
        itemCount: order.items.length,
        total: order.total,
      });

      return order;
    } catch (error) {
      // 统一回滚：任何异常都触发已扣减库存的回滚（仅回滚一次）
      if (deductedItems.length > 0) {
        logger.warn("Order creation failed, rolling back inventory", {
          deductedCount: deductedItems.length,
          error,
        });
        this.rollbackInventory(deductedItems);
      }
      throw error;
    }
  }

  /**
   * 回滚库存（恢复已扣减的库存）
   * @param deductedItems - 已扣减的库存列表
   */
  private rollbackInventory(deductedItems: Array<{ productId: string; quantity: number }>): void {
    for (const item of deductedItems) {
      try {
        this.inventoryService.restore(item.productId, item.quantity);
        logger.info("Inventory rolled back", {
          productId: item.productId,
          quantity: item.quantity,
        });
      } catch (error) {
        logger.error("Failed to rollback inventory", {
          productId: item.productId,
          error,
        });
      }
    }
  }

  /**
   * 查询订单
   * @param id - 订单 ID
   * @returns 订单对象或 null
   */
  getById(id: string): Order | null {
    const order = this.repository.findById(id);
    return order || null;
  }

  /**
   * 取消订单（恢复库存）
   * @param id - 订单 ID
   * @returns 取消后的订单状态
   * @throws NotFoundError - 订单不存在
   * @throws ValidationError - 订单状态不允许取消
   */
  cancel(id: string): { id: string; status: string } {
    // 查询订单
    const order = this.repository.findById(id);
    if (!order) {
      throw new NotFoundError("Order", id);
    }

    // 检查订单状态
    if (order.status !== "pending") {
      throw new ValidationError("status", "only pending orders can be cancelled");
    }

    // 恢复库存（INT-003）
    for (const item of order.items) {
      this.inventoryService.restore(item.productId, item.quantity);
    }

    // 更新订单状态
    order.status = "cancelled";
    this.repository.save(order);

    logger.info("Order cancelled", { orderId: id });

    return {
      id: order.id,
      status: order.status,
    };
  }
}
