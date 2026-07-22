/**
 * 库存管理服务
 * 负责库存的扣减、恢复、查询和初始化
 */

import { NotFoundError, InsufficientStockError, ValidationError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";

interface InventoryRecord {
  productId: string;
  stock: number;
}

export class InventoryService {
  // 内存存储: Map<productId, stock>
  private inventory: Map<string, number> = new Map();

  /**
   * 初始化库存记录
   * @param productId 商品 ID
   * @param stock 初始库存数量
   */
  initStock(productId: string, stock: number): void {
    if (stock < 0) {
      throw new ValidationError("stock", "must be non-negative");
    }
    this.inventory.set(productId, stock);
    logger.info(`Initialized stock for product ${productId}: ${stock}`);
  }

  /**
   * 扣减库存
   * @param productId 商品 ID
   * @param quantity 扣减数量
   * @throws NotFoundError 商品不存在
   * @throws InsufficientStockError 库存不足
   * @throws ValidationError 参数校验失败
   */
  deduct(productId: string, quantity: number): { productId: string; remaining: number } {
    // 校验扣减数量
    if (quantity <= 0) {
      throw new ValidationError("quantity", "must be positive");
    }

    // 检查库存记录是否存在
    const currentStock = this.inventory.get(productId);
    if (currentStock === undefined) {
      throw new NotFoundError("Product", productId);
    }

    // 检查库存是否充足
    if (currentStock < quantity) {
      throw new InsufficientStockError(productId, quantity, currentStock);
    }

    // 扣减库存
    const remaining = currentStock - quantity;
    this.inventory.set(productId, remaining);

    logger.info(`Deducted ${quantity} from product ${productId}, remaining: ${remaining}`);

    return { productId, remaining };
  }

  /**
   * 恢复库存
   * @param productId 商品 ID
   * @param quantity 恢复数量
   * @throws NotFoundError 商品不存在
   * @throws ValidationError 参数校验失败
   */
  restore(productId: string, quantity: number): { productId: string; remaining: number } {
    // 校验恢复数量
    if (quantity <= 0) {
      throw new ValidationError("quantity", "must be positive");
    }

    // 检查库存记录是否存在
    const currentStock = this.inventory.get(productId);
    if (currentStock === undefined) {
      throw new NotFoundError("Product", productId);
    }

    // 恢复库存
    const remaining = currentStock + quantity;
    this.inventory.set(productId, remaining);

    logger.info(`Restored ${quantity} to product ${productId}, remaining: ${remaining}`);

    return { productId, remaining };
  }

  /**
   * 查询库存
   * @param productId 商品 ID
   * @throws NotFoundError 商品不存在
   */
  getStock(productId: string): { productId: string; stock: number } {
    const stock = this.inventory.get(productId);
    if (stock === undefined) {
      throw new NotFoundError("Product", productId);
    }
    return { productId, stock };
  }

  /**
   * 删除库存记录
   * @param productId 商品 ID
   */
  removeStock(productId: string): void {
    this.inventory.delete(productId);
    logger.info(`Removed stock record for product ${productId}`);
  }
}
