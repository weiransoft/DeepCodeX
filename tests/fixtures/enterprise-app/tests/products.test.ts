import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ProductService } from "../src/products/product-service.js";
import { InventoryService } from "../src/inventory/inventory-service.js";
import { NotFoundError, ValidationError } from "../src/utils/errors.js";

describe("ProductsModule 测试", () => {
  describe("TC-PROD-01: 商品创建成功返回商品对象（含 id）", () => {
    it('create({name:"iPhone",price:999,stock:100})，断言 id 非空、字段正确', () => {
      const inventoryService = new InventoryService();
      const productService = new ProductService(inventoryService);

      const product = productService.create({
        name: "iPhone",
        price: 999,
        stock: 100,
      });

      assert.ok(product.id);
      assert.strictEqual(product.name, "iPhone");
      assert.strictEqual(product.price, 999);
      assert.strictEqual(product.stock, 100);
      assert.ok(product.createdAt);
    });
  });

  describe("TC-PROD-02: 商品创建 name 为空返回 ValidationError", () => {
    it('create({name:"",price:999,stock:100})，断言抛 ValidationError', () => {
      const inventoryService = new InventoryService();
      const productService = new ProductService(inventoryService);

      assert.throws(() => productService.create({ name: "", price: 999, stock: 100 }), ValidationError);
    });
  });

  describe("TC-PROD-03: 商品创建 price <= 0 返回 ValidationError", () => {
    it('create({name:"iPhone",price:0,stock:100})，断言抛 ValidationError', () => {
      const inventoryService = new InventoryService();
      const productService = new ProductService(inventoryService);

      assert.throws(() => productService.create({ name: "iPhone", price: 0, stock: 100 }), ValidationError);
    });
  });

  describe("TC-PROD-04: 商品创建 stock < 0 返回 ValidationError", () => {
    it('create({name:"iPhone",price:999,stock:-1})，断言抛 ValidationError', () => {
      const inventoryService = new InventoryService();
      const productService = new ProductService(inventoryService);

      assert.throws(() => productService.create({ name: "iPhone", price: 999, stock: -1 }), ValidationError);
    });
  });

  describe("TC-PROD-05: 商品创建成功同时初始化库存", () => {
    it("create 后 inventoryService.getStock(id).stock 等于 100", () => {
      const inventoryService = new InventoryService();
      const productService = new ProductService(inventoryService);

      const product = productService.create({
        name: "iPhone",
        price: 999,
        stock: 100,
      });

      const stock = inventoryService.getStock(product.id);
      assert.strictEqual(stock.stock, 100);
    });
  });

  describe("TC-PROD-06: 商品查询返回商品对象", () => {
    it("先 create，再 getById，断言字段一致", () => {
      const inventoryService = new InventoryService();
      const productService = new ProductService(inventoryService);

      const created = productService.create({
        name: "iPhone",
        price: 999,
        stock: 100,
      });

      const fetched = productService.getById(created.id);

      assert.ok(fetched);
      assert.strictEqual(fetched.id, created.id);
      assert.strictEqual(fetched.name, created.name);
      assert.strictEqual(fetched.price, created.price);
      assert.strictEqual(fetched.stock, created.stock);
    });
  });

  describe("TC-PROD-07: 商品查询不存在返回 null", () => {
    it('getById("non-existent")，断言返回 null', () => {
      const inventoryService = new InventoryService();
      const productService = new ProductService(inventoryService);

      const result = productService.getById("non-existent");
      assert.strictEqual(result, null);
    });
  });

  describe("TC-PROD-08: 商品列表默认分页 page=1 size=10", () => {
    it("创建 15 个商品，list({})，断言 items.length=10，page=1, size=10, total=15", () => {
      const inventoryService = new InventoryService();
      const productService = new ProductService(inventoryService);

      for (let i = 1; i <= 15; i++) {
        productService.create({
          name: `Product${i}`,
          price: 100 * i,
          stock: 10 * i,
        });
      }

      const result = productService.list({});

      assert.strictEqual(result.items.length, 10);
      assert.strictEqual(result.page, 1);
      assert.strictEqual(result.size, 10);
      assert.strictEqual(result.total, 15);
    });
  });

  describe("TC-PROD-09: 商品列表自定义分页 page=2 size=5", () => {
    it("创建 15 个商品，list({page:2,size:5})，断言 items.length=5，page=2, size=5", () => {
      const inventoryService = new InventoryService();
      const productService = new ProductService(inventoryService);

      for (let i = 1; i <= 15; i++) {
        productService.create({
          name: `Product${i}`,
          price: 100 * i,
          stock: 10 * i,
        });
      }

      const result = productService.list({ page: 2, size: 5 });

      assert.strictEqual(result.items.length, 5);
      assert.strictEqual(result.page, 2);
      assert.strictEqual(result.size, 5);
      assert.strictEqual(result.total, 15);
    });
  });

  describe("TC-PROD-10: 商品列表按 name 模糊搜索", () => {
    it('创建多个商品，list({name:"iPhone"})，断言只返回包含 iPhone 的', () => {
      const inventoryService = new InventoryService();
      const productService = new ProductService(inventoryService);

      productService.create({ name: "iPhone 12", price: 999, stock: 100 });
      productService.create({ name: "iPhone 13", price: 1099, stock: 50 });
      productService.create({ name: "Samsung Galaxy", price: 899, stock: 80 });
      productService.create({ name: "iPad", price: 799, stock: 60 });

      const result = productService.list({ name: "iPhone" });

      assert.strictEqual(result.items.length, 2);
      assert.ok(result.items.every((p) => p.name.includes("iPhone")));
    });
  });

  describe("TC-PROD-11: 商品更新成功返回更新后对象", () => {
    it("create 后 update(id,{price:899})，断言 price=899 其他字段不变", () => {
      const inventoryService = new InventoryService();
      const productService = new ProductService(inventoryService);

      const created = productService.create({
        name: "iPhone",
        price: 999,
        stock: 100,
      });

      const updated = productService.update(created.id, { price: 899 });

      assert.strictEqual(updated.id, created.id);
      assert.strictEqual(updated.name, created.name);
      assert.strictEqual(updated.price, 899);
      assert.strictEqual(updated.stock, created.stock);
    });
  });

  describe("TC-PROD-12: 商品更新不存在抛 NotFoundError", () => {
    it('update("non-existent",{price:899})，断言抛 NotFoundError', () => {
      const inventoryService = new InventoryService();
      const productService = new ProductService(inventoryService);

      assert.throws(() => productService.update("non-existent", { price: 899 }), NotFoundError);
    });
  });

  describe("TC-PROD-13: 商品删除成功返回 void", () => {
    it("create 后 delete(id)，再 getById(id)，断言返回 null", () => {
      const inventoryService = new InventoryService();
      const productService = new ProductService(inventoryService);

      const created = productService.create({
        name: "iPhone",
        price: 999,
        stock: 100,
      });

      productService.delete(created.id);

      const result = productService.getById(created.id);
      assert.strictEqual(result, null);
    });
  });

  describe("TC-PROD-14: 商品删除不存在抛 NotFoundError", () => {
    it('delete("non-existent")，断言抛 NotFoundError', () => {
      const inventoryService = new InventoryService();
      const productService = new ProductService(inventoryService);

      assert.throws(() => productService.delete("non-existent"), NotFoundError);
    });
  });

  describe("TC-PROD-15: 商品删除同时清理库存", () => {
    it("create 后 delete，再 inventoryService.getStock(id)，断言抛 NotFoundError", () => {
      const inventoryService = new InventoryService();
      const productService = new ProductService(inventoryService);

      const created = productService.create({
        name: "iPhone",
        price: 999,
        stock: 100,
      });

      productService.delete(created.id);

      assert.throws(() => inventoryService.getStock(created.id), NotFoundError);
    });
  });
});
