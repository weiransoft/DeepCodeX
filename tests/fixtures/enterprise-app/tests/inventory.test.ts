import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { InventoryService } from "../src/inventory/inventory-service.js";
import { NotFoundError, ValidationError, InsufficientStockError } from "../src/utils/errors.js";

describe("InventoryModule 测试", () => {
  describe("TC-INV-01: 库存初始化", () => {
    it("initStock(pid, 100)，getStock(pid).stock=100", () => {
      const inventoryService = new InventoryService();
      const productId = "test-product-1";

      inventoryService.initStock(productId, 100);
      const result = inventoryService.getStock(productId);

      assert.strictEqual(result.productId, productId);
      assert.strictEqual(result.stock, 100);
    });
  });

  describe("TC-INV-02: 库存扣减成功返回剩余数量", () => {
    it("initStock(pid,100)，deduct(pid,30)，断言 remaining=70", () => {
      const inventoryService = new InventoryService();
      const productId = "test-product-2";

      inventoryService.initStock(productId, 100);
      const result = inventoryService.deduct(productId, 30);

      assert.strictEqual(result.productId, productId);
      assert.strictEqual(result.remaining, 70);

      const stock = inventoryService.getStock(productId);
      assert.strictEqual(stock.stock, 70);
    });
  });

  describe("TC-INV-03: 库存扣减不足抛 InsufficientStockError", () => {
    it("initStock(pid,5)，deduct(pid,10)，断言抛 InsufficientStockError", () => {
      const inventoryService = new InventoryService();
      const productId = "test-product-3";

      inventoryService.initStock(productId, 5);

      assert.throws(() => inventoryService.deduct(productId, 10), InsufficientStockError);

      const stock = inventoryService.getStock(productId);
      assert.strictEqual(stock.stock, 5);
    });
  });

  describe("TC-INV-04: 库存扣减 quantity <= 0 抛 ValidationError", () => {
    it("initStock(pid,100)，deduct(pid,0)，断言抛 ValidationError", () => {
      const inventoryService = new InventoryService();
      const productId = "test-product-4";

      inventoryService.initStock(productId, 100);

      assert.throws(() => inventoryService.deduct(productId, 0), ValidationError);
    });
  });

  describe("TC-INV-05: 库存扣减商品不存在抛 NotFoundError", () => {
    it('deduct("non-existent",10)，断言抛 NotFoundError', () => {
      const inventoryService = new InventoryService();

      assert.throws(() => inventoryService.deduct("non-existent", 10), NotFoundError);
    });
  });

  describe("TC-INV-06: 库存恢复成功返回剩余数量", () => {
    it("initStock(pid,100)，restore(pid,30)，断言 remaining=130", () => {
      const inventoryService = new InventoryService();
      const productId = "test-product-6";

      inventoryService.initStock(productId, 100);
      const result = inventoryService.restore(productId, 30);

      assert.strictEqual(result.productId, productId);
      assert.strictEqual(result.remaining, 130);

      const stock = inventoryService.getStock(productId);
      assert.strictEqual(stock.stock, 130);
    });
  });

  describe("TC-INV-07: 库存恢复 quantity <= 0 抛 ValidationError", () => {
    it("initStock(pid,100)，restore(pid,0)，断言抛 ValidationError", () => {
      const inventoryService = new InventoryService();
      const productId = "test-product-7";

      inventoryService.initStock(productId, 100);

      assert.throws(() => inventoryService.restore(productId, 0), ValidationError);
    });
  });

  describe("TC-INV-08: 库存恢复商品不存在抛 NotFoundError", () => {
    it('restore("non-existent",10)，断言抛 NotFoundError', () => {
      const inventoryService = new InventoryService();

      assert.throws(() => inventoryService.restore("non-existent", 10), NotFoundError);
    });
  });

  describe("TC-INV-09: 库存查询返回当前数量", () => {
    it("initStock(pid,100)，getStock(pid).stock=100", () => {
      const inventoryService = new InventoryService();
      const productId = "test-product-9";

      inventoryService.initStock(productId, 100);
      const result = inventoryService.getStock(productId);

      assert.strictEqual(result.productId, productId);
      assert.strictEqual(result.stock, 100);
    });
  });

  describe("TC-INV-10: 库存查询商品不存在抛 NotFoundError", () => {
    it('getStock("non-existent")，断言抛 NotFoundError', () => {
      const inventoryService = new InventoryService();

      assert.throws(() => inventoryService.getStock("non-existent"), NotFoundError);
    });
  });

  describe("TC-INV-11: 删除库存记录后查询抛 NotFoundError", () => {
    it("initStock 后 removeStock，再 getStock，断言抛 NotFoundError", () => {
      const inventoryService = new InventoryService();
      const productId = "test-product-11";

      inventoryService.initStock(productId, 100);
      inventoryService.removeStock(productId);

      assert.throws(() => inventoryService.getStock(productId), NotFoundError);
    });
  });
});
