/**
 * CodeMap 性能基准测试种子文件 - 产品服务
 *
 * 形成 product-service → order-service 依赖（循环依赖：order → user → product → order）
 */

import type { Order } from "./order-service";

export class ProductService {
  private products: Map<string, Product> = new Map();

  addProduct(product: Product): void {
    this.products.set(product.id, product);
  }

  getProduct(id: string): Product | undefined {
    return this.products.get(id);
  }

  /**
   * 根据订单查询相关产品
   */
  getProductsByOrder(order: Order): Product[] {
    return order.items.map((item) => this.getProduct(item.productId)).filter((p): p is Product => p !== undefined);
  }
}

export interface Product {
  id: string;
  name: string;
  price: number;
  category: string;
}
