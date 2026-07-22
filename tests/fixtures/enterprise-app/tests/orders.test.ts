import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { OrderService } from "../src/orders/order-service.js";
import { ProductService } from "../src/products/product-service.js";
import { InventoryService } from "../src/inventory/inventory-service.js";
import { NotFoundError, ValidationError, InsufficientStockError } from "../src/utils/errors.js";

describe("OrdersModule Tests", () => {
  // TC-ORDER-01: 订单创建成功扣减库存，返回订单对象
  test("TC-ORDER-01: create deducts inventory and returns order", () => {
    const inventoryService = new InventoryService();
    const productService = new ProductService(inventoryService);
    const orderService = new OrderService(productService, inventoryService);

    const product = productService.create({
      name: "iPhone",
      price: 999,
      stock: 100,
    });

    const order = orderService.create({
      items: [{ productId: product.id, quantity: 5 }],
    });

    assert.ok(order.id);
    assert.strictEqual(order.status, "pending");
    assert.strictEqual(order.total, 5 * 999);
    assert.strictEqual(order.items.length, 1);
    assert.strictEqual(order.items[0].productId, product.id);
    assert.strictEqual(order.items[0].quantity, 5);

    const stock = inventoryService.getStock(product.id);
    assert.strictEqual(stock.stock, 95);
  });

  // TC-ORDER-02: 订单创建时库存不足返回错误，不创建订单
  test("TC-ORDER-02: create throws InsufficientStockError when stock insufficient", () => {
    const inventoryService = new InventoryService();
    const productService = new ProductService(inventoryService);
    const orderService = new OrderService(productService, inventoryService);

    const product = productService.create({
      name: "iPhone",
      price: 999,
      stock: 5,
    });

    assert.throws(
      () =>
        orderService.create({
          items: [{ productId: product.id, quantity: 10 }],
        }),
      InsufficientStockError
    );

    const stock = inventoryService.getStock(product.id);
    assert.strictEqual(stock.stock, 5);
  });

  // TC-ORDER-03: 订单创建 items 为空抛 ValidationError
  test("TC-ORDER-03: create throws ValidationError when items empty", () => {
    const inventoryService = new InventoryService();
    const productService = new ProductService(inventoryService);
    const orderService = new OrderService(productService, inventoryService);

    assert.throws(() => orderService.create({ items: [] }), ValidationError);
  });

  // TC-ORDER-04: 订单创建 quantity <= 0 抛 ValidationError
  test("TC-ORDER-04: create throws ValidationError when quantity <= 0", () => {
    const inventoryService = new InventoryService();
    const productService = new ProductService(inventoryService);
    const orderService = new OrderService(productService, inventoryService);

    const product = productService.create({
      name: "iPhone",
      price: 999,
      stock: 100,
    });

    assert.throws(
      () =>
        orderService.create({
          items: [{ productId: product.id, quantity: 0 }],
        }),
      ValidationError
    );

    assert.throws(
      () =>
        orderService.create({
          items: [{ productId: product.id, quantity: -1 }],
        }),
      ValidationError
    );
  });

  // TC-ORDER-05: 订单创建商品不存在抛 NotFoundError
  test("TC-ORDER-05: create throws NotFoundError when product not found", () => {
    const inventoryService = new InventoryService();
    const productService = new ProductService(inventoryService);
    const orderService = new OrderService(productService, inventoryService);

    assert.throws(
      () =>
        orderService.create({
          items: [{ productId: "non-existent", quantity: 1 }],
        }),
      NotFoundError
    );
  });

  // TC-ORDER-06: 订单创建多个商品总价正确
  test("TC-ORDER-06: create calculates total correctly for multiple products", () => {
    const inventoryService = new InventoryService();
    const productService = new ProductService(inventoryService);
    const orderService = new OrderService(productService, inventoryService);

    const p1 = productService.create({
      name: "iPhone",
      price: 999,
      stock: 100,
    });

    const p2 = productService.create({
      name: "iPad",
      price: 799,
      stock: 100,
    });

    const order = orderService.create({
      items: [
        { productId: p1.id, quantity: 2 },
        { productId: p2.id, quantity: 3 },
      ],
    });

    const expectedTotal = 2 * 999 + 3 * 799;
    assert.strictEqual(order.total, expectedTotal);
    assert.strictEqual(order.items.length, 2);
  });

  // TC-ORDER-07: 订单创建失败时事务回滚已扣减的库存
  test("TC-ORDER-07: create rolls back inventory on failure", () => {
    const inventoryService = new InventoryService();
    const productService = new ProductService(inventoryService);
    const orderService = new OrderService(productService, inventoryService);

    const p1 = productService.create({
      name: "iPhone",
      price: 999,
      stock: 100,
    });

    const p2 = productService.create({
      name: "iPad",
      price: 799,
      stock: 100,
    });

    assert.throws(
      () =>
        orderService.create({
          items: [
            { productId: p1.id, quantity: 5 },
            { productId: p2.id, quantity: 200 },
          ],
        }),
      InsufficientStockError
    );

    const stock1 = inventoryService.getStock(p1.id);
    assert.strictEqual(stock1.stock, 100);
  });

  // TC-ORDER-08: 订单查询返回订单对象
  test("TC-ORDER-08: getById returns order", () => {
    const inventoryService = new InventoryService();
    const productService = new ProductService(inventoryService);
    const orderService = new OrderService(productService, inventoryService);

    const product = productService.create({
      name: "iPhone",
      price: 999,
      stock: 100,
    });

    const created = orderService.create({
      items: [{ productId: product.id, quantity: 5 }],
    });

    const order = orderService.getById(created.id);
    assert.ok(order);
    assert.strictEqual(order.id, created.id);
    assert.strictEqual(order.status, "pending");
    assert.strictEqual(order.total, created.total);
  });

  // TC-ORDER-09: 订单查询不存在返回 null
  test("TC-ORDER-09: getById returns null when not found", () => {
    const inventoryService = new InventoryService();
    const productService = new ProductService(inventoryService);
    const orderService = new OrderService(productService, inventoryService);

    const order = orderService.getById("non-existent");
    assert.strictEqual(order, null);
  });

  // TC-ORDER-10: 订单取消成功恢复库存，状态变为 cancelled
  test("TC-ORDER-10: cancel restores inventory and updates status", () => {
    const inventoryService = new InventoryService();
    const productService = new ProductService(inventoryService);
    const orderService = new OrderService(productService, inventoryService);

    const product = productService.create({
      name: "iPhone",
      price: 999,
      stock: 100,
    });

    const order = orderService.create({
      items: [{ productId: product.id, quantity: 5 }],
    });

    const result = orderService.cancel(order.id);

    assert.strictEqual(result.status, "cancelled");

    const stock = inventoryService.getStock(product.id);
    assert.strictEqual(stock.stock, 100);

    const cancelled = orderService.getById(order.id);
    assert.ok(cancelled);
    assert.strictEqual(cancelled.status, "cancelled");
  });

  // TC-ORDER-11: 已取消的订单再次取消抛错
  test("TC-ORDER-11: cancel throws ValidationError when already cancelled", () => {
    const inventoryService = new InventoryService();
    const productService = new ProductService(inventoryService);
    const orderService = new OrderService(productService, inventoryService);

    const product = productService.create({
      name: "iPhone",
      price: 999,
      stock: 100,
    });

    const order = orderService.create({
      items: [{ productId: product.id, quantity: 5 }],
    });

    orderService.cancel(order.id);

    assert.throws(() => orderService.cancel(order.id), ValidationError);
  });

  // TC-ORDER-12: 订单取消不存在抛 NotFoundError
  test("TC-ORDER-12: cancel throws NotFoundError when not found", () => {
    const inventoryService = new InventoryService();
    const productService = new ProductService(inventoryService);
    const orderService = new OrderService(productService, inventoryService);

    assert.throws(() => orderService.cancel("non-existent"), NotFoundError);
  });
});
