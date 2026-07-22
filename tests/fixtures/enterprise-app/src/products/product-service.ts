/**
 * 商品管理服务
 * 负责商品的 CRUD 操作，并与库存模块联动
 */

import { randomUUID } from "crypto";
import { Repository } from "../utils/repository.js";
import { NotFoundError, ValidationError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import type { InventoryService } from "../inventory/inventory-service.js";

/** 商品实体 */
export interface Product {
  id: string;
  name: string;
  price: number;
  stock: number;
  createdAt: string;
}

/** 商品仓储 */
class ProductRepository extends Repository<Product> {}

export class ProductService {
  private repository: ProductRepository;
  private inventoryService: InventoryService;

  constructor(inventoryService: InventoryService) {
    this.repository = new ProductRepository();
    this.inventoryService = inventoryService;
  }

  /**
   * 创建商品（同时初始化库存记录）
   * @param input - 商品输入数据
   * @returns 创建的商品对象
   * @throws ValidationError - 参数校验失败
   */
  create(input: { name: string; price: number; stock: number }): Product {
    // 校验 name
    if (!input.name || input.name.trim().length === 0) {
      throw new ValidationError("name", "must not be empty");
    }
    if (input.name.length > 100) {
      throw new ValidationError("name", "must not exceed 100 characters");
    }

    // 校验 price
    if (input.price <= 0) {
      throw new ValidationError("price", "must be > 0");
    }

    // 校验 stock
    if (input.stock < 0) {
      throw new ValidationError("stock", "must be >= 0");
    }

    // 创建商品对象
    const product: Product = {
      id: randomUUID(),
      name: input.name.trim(),
      price: input.price,
      stock: input.stock,
      createdAt: new Date().toISOString(),
    };

    // 保存商品
    this.repository.save(product);

    // 初始化库存记录（INT-004）
    this.inventoryService.initStock(product.id, product.stock);

    logger.info("Product created", { productId: product.id, name: product.name });

    return product;
  }

  /**
   * 查询单个商品
   * @param id - 商品 ID
   * @returns 商品对象或 null
   */
  getById(id: string): Product | null {
    const product = this.repository.findById(id);
    return product || null;
  }

  /**
   * 列表查询（分页 + 模糊搜索）
   * @param query - 查询参数
   * @returns 分页结果
   */
  list(query: { page?: number; size?: number; name?: string }): {
    items: Product[];
    total: number;
    page: number;
    size: number;
  } {
    // 设置默认分页参数
    const page = query.page && query.page > 0 ? query.page : 1;
    const size = query.size && query.size > 0 ? query.size : 10;

    // 获取所有商品
    let products = this.repository.findAll();

    // 按 name 模糊搜索
    if (query.name) {
      const searchTerm = query.name.toLowerCase();
      products = products.filter((p) => p.name.toLowerCase().includes(searchTerm));
    }

    const total = products.length;

    // 分页处理
    const startIndex = (page - 1) * size;
    const endIndex = startIndex + size;
    const items = products.slice(startIndex, endIndex);

    logger.debug("Product list queried", { page, size, total, name: query.name });

    return {
      items,
      total,
      page,
      size,
    };
  }

  /**
   * 更新商品（部分字段）
   * @param id - 商品 ID
   * @param input - 更新数据
   * @returns 更新后的商品对象
   * @throws NotFoundError - 商品不存在
   * @throws ValidationError - 参数校验失败
   */
  update(id: string, input: Partial<{ name: string; price: number; stock: number }>): Product {
    // 查询商品
    const product = this.repository.findById(id);
    if (!product) {
      throw new NotFoundError("Product", id);
    }

    // 校验并更新 name
    if (input.name !== undefined) {
      if (!input.name || input.name.trim().length === 0) {
        throw new ValidationError("name", "must not be empty");
      }
      if (input.name.length > 100) {
        throw new ValidationError("name", "must not exceed 100 characters");
      }
      product.name = input.name.trim();
    }

    // 校验并更新 price
    if (input.price !== undefined) {
      if (input.price <= 0) {
        throw new ValidationError("price", "must be > 0");
      }
      product.price = input.price;
    }

    // 校验并更新 stock
    if (input.stock !== undefined) {
      if (input.stock < 0) {
        throw new ValidationError("stock", "must be >= 0");
      }
      product.stock = input.stock;
      // 同步更新库存记录
      this.inventoryService.initStock(product.id, product.stock);
    }

    // 保存更新
    this.repository.save(product);

    logger.info("Product updated", { productId: id, updates: input });

    return product;
  }

  /**
   * 删除商品（同时清理库存记录）
   * @param id - 商品 ID
   * @throws NotFoundError - 商品不存在
   */
  delete(id: string): void {
    // 检查商品是否存在
    if (!this.repository.exists(id)) {
      throw new NotFoundError("Product", id);
    }

    // 删除商品
    this.repository.delete(id);

    // 清理库存记录（INT-004）
    this.inventoryService.removeStock(id);

    logger.info("Product deleted", { productId: id });
  }
}
