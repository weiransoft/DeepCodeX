/**
 * 内存仓储基类
 * 使用 Map 存储数据,提供基础 CRUD 操作
 */

import { logger } from "./logger.js";

export class Repository<T extends { id: string }> {
  // 内存存储: Map<id, entity>
  protected storage: Map<string, T> = new Map();

  /**
   * 创建记录
   * @param entity 实体对象
   */
  create(entity: T): T {
    this.storage.set(entity.id, entity);
    logger.debug(`Created entity with id: ${entity.id}`);
    return entity;
  }

  /**
   * 保存记录（等价于 create，兼容 Spring Data JPA / TypeORM 命名约定）
   *
   * v2.1.3 E2E 修复：LLM 产出的 ProductService/OrderService 使用 `save` 方法名，
   * 而基类原方法名为 `create`。为保持接口契约一致，在基类添加 `save` 别名，
   * 避免修改每个 service 的调用点。
   *
   * @param entity 实体对象
   */
  save(entity: T): T {
    this.storage.set(entity.id, entity);
    logger.debug(`Saved entity with id: ${entity.id}`);
    return entity;
  }

  /**
   * 根据 ID 查询单个记录
   * @param id 实体 ID
   */
  findById(id: string): T | null {
    const entity = this.storage.get(id);
    return entity || null;
  }

  /**
   * 检查指定 ID 的记录是否存在
   *
   * v2.1.3 E2E 修复：LLM 产出的 ProductService 使用 `exists` 方法检查存在性，
   * 基类原本需要通过 `findById(id) !== null` 实现。为保持接口契约一致，添加此方法。
   *
   * @param id 实体 ID
   * @returns 存在返回 true，否则 false
   */
  exists(id: string): boolean {
    return this.storage.has(id);
  }

  /**
   * 查询所有记录
   */
  findAll(): T[] {
    return Array.from(this.storage.values());
  }

  /**
   * 更新记录
   * @param id 实体 ID
   * @param updates 更新字段
   */
  update(id: string, updates: Partial<T>): T | null {
    const existing = this.storage.get(id);
    if (!existing) {
      return null;
    }
    const updated = { ...existing, ...updates };
    this.storage.set(id, updated);
    logger.debug(`Updated entity with id: ${id}`);
    return updated;
  }

  /**
   * 删除记录
   * @param id 实体 ID
   */
  delete(id: string): boolean {
    const result = this.storage.delete(id);
    if (result) {
      logger.debug(`Deleted entity with id: ${id}`);
    }
    return result;
  }

  /**
   * 清空所有记录 (用于测试)
   */
  clear(): void {
    this.storage.clear();
  }
}
