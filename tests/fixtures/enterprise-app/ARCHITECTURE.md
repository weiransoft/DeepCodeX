# 订单管理 REST API 架构设计文档

> **项目名称**：Order Management API
> **版本**：v1.0
> **创建时间**：2026-07-21
> **状态**：已实施
> **关联文档**：PRD.md（需求）、TEST_PLAN.md（测试计划）

---

## 1. 架构原则

### 1.1 设计原则

1. **分层架构**：Router → Service → Repository 三层分离
2. **依赖注入**：Service 通过构造函数注入 Repository，便于测试
3. **单一职责**：每个模块只负责一个业务领域
4. **YAGNI**：只实现 PRD 中的功能，不预留扩展点
5. **Fail Fast**：参数校验在入口处完成，错误立即返回

### 1.2 Karpathy 四原则应用

| 原则 | 应用 |
|------|------|
| Think Before Coding | 先写 PRD 和本文档，明确所有接口契约后再编码 |
| Simplicity First | 内存存储（不引入数据库）；JWT 直接用 jsonwebtoken；UUID 用 Node.js 标准库 |
| Surgical Changes | 每个模块独立文件，修改不影响其他模块 |
| Goal-Driven | 验收标准 AC-001~AC-017 作为退出标准 |

---

## 2. 模块结构

```
enterprise-app/
├── PRD.md                              # 产品需求文档
├── ARCHITECTURE.md                     # 本文档
├── TEST_PLAN.md                        # 测试计划
├── package.json                        # 项目配置
├── tsconfig.json                       # TypeScript 配置
├── src/
│   ├── index.ts                        # 应用入口（Express app + 路由挂载）
│   ├── auth/
│   │   └── jwt.ts                      # JWT 认证模块（签发 + 验证 + 中间件）
│   ├── products/
│   │   └── product-service.ts          # 商品管理服务（CRUD + 校验）
│   ├── orders/
│   │   └── order-service.ts            # 订单管理服务（创建/查询/取消 + 库存联动）
│   ├── inventory/
│   │   └── inventory-service.ts        # 库存管理服务（扣减/恢复/查询）
│   └── utils/
│       ├── logger.ts                   # 日志工具（带时间戳和级别）
│       ├── repository.ts               # 内存仓储基类（Map 存储 + CRUD）
│       └── errors.ts                   # 业务错误类（NotFound/Validation/InsufficientStock）
└── tests/
    ├── auth.test.ts                    # 认证模块测试
    ├── products.test.ts                # 商品模块测试
    ├── orders.test.ts                  # 订单模块测试
    └── inventory.test.ts               # 库存模块测试
```

---

## 3. 模块设计

### 3.1 AuthModule（认证模块）

**文件**：`src/auth/jwt.ts`

**职责**：
- 签发 JWT token（登录成功时）
- 验证 JWT token（中间件形式）
- 暴露 `authMiddleware` 用于保护路由

**接口契约**：
```typescript
/** 签发 JWT token */
function signToken(payload: { username: string }): string

/** 验证 JWT token，返回 payload 或抛错 */
function verifyToken(token: string): { username: string; iat: number }

/** Express 中间件：验证 Authorization 头 */
function authMiddleware(req: Request, res: Response, next: NextFunction): void

/** 登录处理函数 */
function loginHandler(req: Request, res: Response): void
```

**配置**：
- JWT 密钥：`test-secret-key`（硬编码，仅用于 fixture）
- 过期时间：3600 秒（1 小时）
- 用户名：`admin`，密码：`admin123`

### 3.2 ProductsModule（商品模块）

**文件**：`src/products/product-service.ts`

**职责**：
- 商品的 CRUD 操作
- 商品参数校验
- 与 Inventory 模块联动（创建时初始化库存，删除时清理库存）

**接口契约**：
```typescript
interface Product {
  id: string;
  name: string;
  price: number;
  stock: number;
  createdAt: string;
}

class ProductService {
  constructor(inventoryService: InventoryService)

  /** 创建商品（同时初始化库存记录） */
  create(input: { name: string; price: number; stock: number }): Product

  /** 查询单个商品 */
  getById(id: string): Product | null

  /** 列表查询（分页 + 模糊搜索） */
  list(query: { page?: number; size?: number; name?: string }): {
    items: Product[];
    total: number;
    page: number;
    size: number;
  }

  /** 更新商品（部分字段） */
  update(id: string, input: Partial<{ name: string; price: number; stock: number }>): Product

  /** 删除商品（同时清理库存记录） */
  delete(id: string): void
}
```

**校验规则**：
- name：非空，长度 1-100
- price：> 0
- stock：>= 0

### 3.3 OrdersModule（订单模块）

**文件**：`src/orders/order-service.ts`

**职责**：
- 订单创建（联动 Products 查询 + Inventory 扣减）
- 订单查询
- 订单取消（联动 Inventory 恢复）
- 库存不足时事务回滚

**接口契约**：
```typescript
interface OrderItem {
  productId: string;
  productName: string;
  price: number;
  quantity: number;
  subtotal: number;
}

interface Order {
  id: string;
  items: OrderItem[];
  total: number;
  status: 'pending' | 'cancelled';
  createdAt: string;
}

class OrderService {
  constructor(productService: ProductService, inventoryService: InventoryService)

  /** 创建订单（事务：扣减库存 + 创建订单，失败回滚） */
  create(input: { items: Array<{ productId: string; quantity: number }> }): Order

  /** 查询订单 */
  getById(id: string): Order | null

  /** 取消订单（恢复库存） */
  cancel(id: string): { id: string; status: string }
}
```

**事务策略**：
1. 验证所有商品存在
2. 逐个扣减库存（记录已扣减的列表）
3. 任一扣减失败 → 回滚已扣减的库存
4. 全部扣减成功 → 创建订单记录

### 3.4 InventoryModule（库存模块）

**文件**：`src/inventory/inventory-service.ts`

**职责**：
- 库存扣减（检查 + 减少）
- 库存恢复（增加）
- 库存查询
- 库存初始化（创建商品时）
- 库存清理（删除商品时）

**接口契约**：
```typescript
class InventoryService {
  /** 初始化库存记录 */
  initStock(productId: string, stock: number): void

  /** 扣减库存（库存不足抛 InsufficientStockError） */
  deduct(productId: string, quantity: number): { productId: string; remaining: number }

  /** 恢复库存 */
  restore(productId: string, quantity: number): { productId: string; remaining: number }

  /** 查询库存 */
  getStock(productId: string): { productId: string; stock: number }

  /** 删除库存记录 */
  removeStock(productId: string): void
}
```

### 3.5 UtilsModule（工具模块）

**文件**：`src/utils/logger.ts`、`src/utils/repository.ts`、`src/utils/errors.ts`

**职责**：
- `logger.ts`：统一日志格式（`[LEVEL] [timestamp] message`）
- `repository.ts`：内存仓储基类（Map 存储，提供 CRUD）
- `errors.ts`：业务错误类（`NotFoundError` / `ValidationError` / `InsufficientStockError`）

---

## 4. 集成关系

### 4.1 模块依赖图

```
                ┌──────────────────┐
                │   Express App    │
                │   (index.ts)     │
                └────────┬─────────┘
                         │
        ┌────────────────┼────────────────┐
        │                │                │
┌───────▼──────┐  ┌──────▼───────┐  ┌─────▼──────┐
│  AuthRouter  │  │ ProductRouter│  │ OrderRouter│
└───────┬──────┘  └──────┬───────┘  └─────┬──────┘
        │                │                │
        │         ┌──────▼───────┐  ┌─────▼──────┐
        │         │ProductService│  │OrderService│
        │         └──────┬───────┘  └─────┬──────┘
        │                │                │
        │                │     ┌──────────┤
        │                │     │          │
        │         ┌──────▼─────▼──────┐   │
        │         │ InventoryService  │◄──┘
        │         └───────────────────┘
        │                │
        │         ┌──────▼───────┐
        │         │  Repository  │
        │         └──────────────┘
        │
┌───────▼──────┐
│   Logger     │  ← 所有模块共享
└──────────────┘
```

### 4.2 集成关系清单

| 集成 ID | 集成关系 | 实现位置 | 关联功能 |
|---------|---------|---------|---------|
| INT-001 | AuthMiddleware → 所有受保护路由 | `src/index.ts` 中 app.use('/api/products', authMiddleware, ...) | F-001 |
| INT-002 | OrderService → ProductService | `order-service.ts` constructor 注入 | F-007 |
| INT-003 | OrderService → InventoryService | `order-service.ts` constructor 注入 | F-007, F-009 |
| INT-004 | ProductService → InventoryService | `product-service.ts` constructor 注入 | F-002, F-006 |
| INT-005 | 所有 Service → Repository | `utils/repository.ts` 基类继承 | 全部 |
| INT-006 | 所有模块 → Logger | `utils/logger.ts` 导入 | 全部 |

### 4.3 数据流

#### 订单创建数据流（F-007）

```
Client POST /api/orders
  ↓
authMiddleware（验证 JWT）
  ↓
OrderRouter → OrderService.create()
  ↓
  ├─→ ProductService.getById() × N（验证商品存在）
  ├─→ InventoryService.deduct() × N（扣减库存）
  │     └─→ 失败时：InventoryService.restore() × N（回滚）
  └─→ OrderRepository.create()（创建订单记录）
  ↓
Response 201 + Order
```

---

## 5. 数据模型

### 5.1 Product

```typescript
interface Product {
  id: string;          // UUID v4
  name: string;        // 1-100 字符
  price: number;       // > 0
  stock: number;       // >= 0
  createdAt: string;   // ISO 8601
}
```

### 5.2 Order

```typescript
interface Order {
  id: string;          // UUID v4
  items: OrderItem[];  // 非空数组
  total: number;       // Σ(subtotal)
  status: 'pending' | 'cancelled';
  createdAt: string;   // ISO 8601
}

interface OrderItem {
  productId: string;
  productName: string;
  price: number;
  quantity: number;    // > 0
  subtotal: number;    // price × quantity
}
```

### 5.3 Inventory

```typescript
// 内存中的库存记录（不对外暴露）
interface InventoryRecord {
  productId: string;
  stock: number;
}
```

---

## 6. 错误处理

### 6.1 业务错误类

```typescript
class NotFoundError extends Error {
  constructor(resource: string, id: string)
  // message: `${resource} not found: ${id}`
}

class ValidationError extends Error {
  constructor(field: string, reason: string)
  // message: `Validation failed for ${field}: ${reason}`
}

class InsufficientStockError extends Error {
  constructor(productId: string, requested: number, available: number)
  // message: `Insufficient stock for product ${productId}: requested ${requested}, available ${available}`
}

class AuthenticationError extends Error {
  constructor(reason: string)
  // message: `Authentication failed: ${reason}`
}
```

### 6.2 HTTP 状态码映射

| 错误类型 | HTTP 状态码 |
|---------|------------|
| ValidationError | 400 |
| AuthenticationError | 401 |
| NotFoundError | 404 |
| InsufficientStockError | 400 |
| 其他未捕获错误 | 500 |

### 6.3 错误响应格式

```json
{
  "error": "Validation failed for name: must not be empty"
}
```

---

## 7. 安全设计

### 7.1 JWT 认证

- 密钥：`test-secret-key`（仅用于 fixture，生产环境应从环境变量读取）
- 算法：HS256
- 过期时间：3600 秒
- payload：`{ username: string, iat: number }`

### 7.2 路由保护

- `/api/auth/login` 无需认证
- `/api/products/*` 需认证
- `/api/orders/*` 需认证
- `/api/inventory/*` 需认证

### 7.3 输入校验

- 所有接口在 Service 层校验输入
- 校验失败抛 `ValidationError`，由 Router 转为 400 响应

---

## 8. 可测试性设计

### 8.1 依赖注入

所有 Service 通过构造函数注入依赖：
```typescript
const inventoryService = new InventoryService();
const productService = new ProductService(inventoryService);
const orderService = new OrderService(productService, inventoryService);
```

### 8.2 内存存储

使用 `Map<string, T>` 作为存储，测试间隔离通过创建新实例实现。

### 8.3 日志可观察

Logger 输出到 console，测试时可观察执行流程。

---

## 9. 技术决策（ADR）

### ADR-001：使用内存存储而非数据库

- **决策**：使用 `Map` 作为存储
- **理由**：fixture 需要快速启动和隔离；YAGNI 原则
- **代价**：数据不持久化（fixture 不需要）

### ADR-002：使用 jsonwebtoken 而非自实现 JWT

- **决策**：引入 `jsonwebtoken` 依赖
- **理由**：标准库实现复杂；jsonwebtoken 是事实标准
- **代价**：增加 1 个依赖

### ADR-003：使用 node:test 而非 jest

- **决策**：使用 Node.js 20+ 内置的 `node:test`
- **理由**：零依赖；与 DeepCodeX-cli 测试体系一致
- **代价**：无 watch 模式（fixture 不需要）

### ADR-004：Service 层不直接操作 HTTP

- **决策**：Service 层只接收/返回业务对象，不操作 req/res
- **理由**：可测试性；单一职责
- **代价**：Router 层需要做对象映射

---

## 10. 性能设计

### 10.1 内存存储性能

- 查询：O(1)（Map.get）
- 列表：O(n)（Array.filter + Array.slice）
- 创建：O(1)（Map.set）
- 更新：O(1)（Map.set）
- 删除：O(1)（Map.delete）

### 10.2 并发处理

- JavaScript 单线程，无需锁
- Promise.all 支持并发请求

---

## 11. 状态追踪

| 阶段 | 状态 | 完成时间 |
|------|------|---------|
| 架构设计 | ✅ 完成 | 2026-07-21 |
| 模块划分 | ✅ 完成 | 2026-07-21 |
| 接口契约定义 | ✅ 完成 | 2026-07-21 |
| 数据模型设计 | ✅ 完成 | 2026-07-21 |
| 错误处理设计 | ✅ 完成 | 2026-07-21 |
| 安全设计 | ✅ 完成 | 2026-07-21 |
