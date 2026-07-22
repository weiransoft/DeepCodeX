# 订单管理 REST API 产品需求文档（PRD）

> **项目名称**：Order Management API
> **版本**：v1.0
> **创建时间**：2026-07-21
> **状态**：已实施
> **用途**：DeepCodeX CLI 端到端测试 fixture，用于验证多角色协作产出的代码与文档一致性

---

## 1. 背景与目标

### 1.1 业务背景

电商平台需要一个轻量级的订单管理后端服务，提供商品管理、订单处理、库存控制等核心能力。该服务作为电商系统的核心业务模块，需要保证数据一致性、接口可用性、操作可审计性。

### 1.2 产品目标

构建一个基于 Node.js + Express + TypeScript 的 REST API 服务，提供：
- 用户认证（JWT）
- 商品管理（CRUD）
- 订单管理（创建/查询/取消）
- 库存管理（扣减/恢复）

### 1.3 非目标（YAGNI 显式声明）

- ❌ 不实现支付集成
- ❌ 不实现物流跟踪
- ❌ 不实现用户注册（仅认证）
- ❌ 不实现分布式部署（单进程内存存储）

---

## 2. 功能需求

### 2.1 功能点清单

| 功能 ID | 功能名称 | 优先级 | 模块 |
|---------|---------|--------|------|
| F-001 | JWT 用户认证 | P0 | auth |
| F-002 | 商品创建 | P0 | products |
| F-003 | 商品查询（单个） | P0 | products |
| F-004 | 商品列表查询 | P0 | products |
| F-005 | 商品更新 | P0 | products |
| F-006 | 商品删除 | P0 | products |
| F-007 | 订单创建 | P0 | orders |
| F-008 | 订单查询（单个） | P0 | orders |
| F-009 | 订单取消 | P0 | orders |
| F-010 | 库存扣减 | P0 | inventory |
| F-011 | 库存恢复 | P0 | inventory |
| F-012 | 库存查询 | P0 | inventory |

### 2.2 功能详细描述

#### F-001 JWT 用户认证

- **输入**：用户名 + 密码
- **输出**：JWT token（有效期 1 小时）
- **规则**：
  - 用户名固定为 `admin`，密码固定为 `admin123`（仅用于测试 fixture）
  - 密码错误时返回 401
  - JWT payload 包含 `username` 和 `iat`
  - 后续接口需通过 `Authorization: Bearer <token>` 验证

#### F-002 商品创建

- **输入**：`{ name: string, price: number, stock: number }`
- **输出**：`{ id: string, name: string, price: number, stock: number, createdAt: string }`
- **规则**：
  - name 非空，长度 1-100
  - price > 0
  - stock >= 0
  - id 自动生成（UUID v4）

#### F-003 商品查询（单个）

- **输入**：`productId: string`
- **输出**：商品对象
- **规则**：商品不存在返回 404

#### F-004 商品列表查询

- **输入**：`page?: number, size?: number`（分页参数，默认 page=1, size=10）
- **输出**：`{ items: Product[], total: number, page: number, size: number }`
- **规则**：支持按 name 模糊搜索（`?name=xxx`）

#### F-005 商品更新

- **输入**：`productId: string, { name?, price?, stock? }`
- **输出**：更新后的商品对象
- **规则**：商品不存在返回 404；只能更新提供的字段

#### F-006 商品删除

- **输入**：`productId: string`
- **输出**：`{ success: boolean }`
- **规则**：商品不存在返回 404；删除后库存记录也删除

#### F-007 订单创建

- **输入**：`{ items: Array<{ productId: string, quantity: number }> }`
- **输出**：`{ id: string, items: OrderItem[], total: number, status: string, createdAt: string }`
- **规则**：
  - items 非空，每个 quantity > 0
  - 商品必须存在
  - 库存必须充足（创建订单时扣减库存）
  - 订单状态初始为 `pending`
  - 总价 = Σ(price × quantity)
  - 库存扣减失败时整个事务回滚

#### F-008 订单查询（单个）

- **输入**：`orderId: string`
- **输出**：订单对象
- **规则**：订单不存在返回 404

#### F-009 订单取消

- **输入**：`orderId: string`
- **输出**：`{ id: string, status: string }`
- **规则**：
  - 订单不存在返回 404
  - 只有 `pending` 状态的订单可取消
  - 取消订单时恢复库存
  - 取消后状态变为 `cancelled`

#### F-010 库存扣减

- **输入**：`productId: string, quantity: number`
- **输出**：`{ productId: string, remaining: number }`
- **规则**：
  - quantity > 0
  - 库存不足返回 400
  - 商品不存在返回 404

#### F-011 库存恢复

- **输入**：`productId: string, quantity: number`
- **输出**：`{ productId: string, remaining: number }`
- **规则**：
  - quantity > 0
  - 商品不存在返回 404

#### F-012 库存查询

- **输入**：`productId: string`
- **输出**：`{ productId: string, stock: number }`
- **规则**：商品不存在返回 404

---

## 3. 验收标准

| 验收 ID | 验收标准 | 关联功能 |
|---------|---------|---------|
| AC-001 | 正确用户名密码登录返回 JWT token，错误密码返回 401 | F-001 |
| AC-002 | 无 token 访问受保护接口返回 401 | F-001 |
| AC-003 | 商品创建成功返回 201 + 商品对象（含 id） | F-002 |
| AC-004 | 商品创建 name 为空返回 400 | F-002 |
| AC-005 | 商品创建 price <= 0 返回 400 | F-002 |
| AC-006 | 商品查询返回商品对象，不存在返回 404 | F-003 |
| AC-007 | 商品列表支持分页，默认 page=1 size=10 | F-004 |
| AC-008 | 商品更新成功返回更新后对象，不存在返回 404 | F-005 |
| AC-009 | 商品删除成功返回 success=true，不存在返回 404 | F-006 |
| AC-010 | 订单创建成功扣减库存，返回 201 + 订单对象 | F-007 |
| AC-011 | 订单创建时库存不足返回 400，不创建订单 | F-007 |
| AC-012 | 订单查询返回订单对象，不存在返回 404 | F-008 |
| AC-013 | 订单取消成功恢复库存，状态变为 cancelled | F-009 |
| AC-014 | 已取消的订单再次取消返回 400 | F-009 |
| AC-015 | 库存扣减成功返回剩余数量，库存不足返回 400 | F-010 |
| AC-016 | 库存恢复成功返回剩余数量 | F-011 |
| AC-017 | 库存查询返回当前库存数量 | F-012 |

---

## 4. 接口契约

### 4.1 认证接口

```
POST /api/auth/login
  Body: { username: string, password: string }
  Response 200: { token: string, expiresIn: number }
  Response 401: { error: string }
```

### 4.2 商品接口

```
POST   /api/products          创建商品
GET    /api/products          列表查询（?page=&size=&name=）
GET    /api/products/:id      查询单个
PUT    /api/products/:id      更新
DELETE /api/products/:id      删除
```

### 4.3 订单接口

```
POST   /api/orders            创建订单
GET    /api/orders/:id        查询订单
POST   /api/orders/:id/cancel 取消订单
```

### 4.4 库存接口

```
POST   /api/inventory/:productId/deduct   扣减库存
POST   /api/inventory/:productId/restore  恢复库存
GET    /api/inventory/:productId          查询库存
```

---

## 5. 非功能需求

### 5.1 性能

- 单接口响应时间 < 100ms（内存存储）
- 支持并发请求（Promise.all）

### 5.2 安全

- 所有接口（除 /api/auth/login）需 JWT 认证
- JWT 签名密钥：`test-secret-key`（仅用于 fixture）
- 密码不明文存储（fixture 中硬编码）

### 5.3 可测试性

- 每个模块可独立测试（依赖注入）
- 提供 in-memory repository，便于单元测试
- 日志可观察（console + 自定义 logger）

---

## 6. 测试覆盖要求

| 模块 | 最低测试用例数 | 覆盖率要求 |
|------|--------------|----------|
| auth | 5 | ≥ 90% |
| products | 10 | ≥ 90% |
| orders | 8 | ≥ 90% |
| inventory | 6 | ≥ 90% |
| **总计** | **29** | **≥ 90%** |

---

## 7. 技术栈

- **运行时**：Node.js 20+
- **语言**：TypeScript 5+
- **HTTP 框架**：Express 4
- **认证**：jsonwebtoken
- **UUID**：crypto.randomUUID（Node.js 标准库）
- **测试**：node:test + node:assert/strict
- **构建**：tsx（直接运行 TS，无需编译）

---

## 8. 集成关系

```
┌─────────────────────────────────────────────┐
│             Express App (index.ts)            │
└─────────────────────────────────────────────┘
                    │
       ┌────────────┼────────────┐
       │            │            │
┌──────▼──────┐ ┌───▼────┐ ┌────▼─────┐
│ AuthModule  │ │ Orders │ │ Products │
│  (JWT)      │ │        │ │          │
└──────┬──────┘ └───┬────┘ └────┬─────┘
       │            │           │
       │            │     ┌─────▼─────┐
       │            ├────►│ Inventory │
       │            │     └───────────┘
       │            │
┌──────▼──────────▼─┐
│   Logger (utils)   │
└────────────────────┘
```

**关键集成关系**：
1. `AuthModule` → 所有路由（中间件形式）
2. `Orders` → `Products`（创建订单时查询商品）
3. `Orders` → `Inventory`（创建订单时扣减库存，取消订单时恢复库存）
4. `Products` → `Inventory`（创建商品时初始化库存，删除商品时删除库存）
5. 所有模块 → `Logger`（日志记录）

---

## 9. 交付物

- [x] `src/index.ts` - 应用入口
- [x] `src/auth/jwt.ts` - JWT 认证模块
- [x] `src/products/product-service.ts` - 商品管理服务
- [x] `src/orders/order-service.ts` - 订单管理服务
- [x] `src/inventory/inventory-service.ts` - 库存管理服务
- [x] `src/utils/logger.ts` - 日志工具
- [x] `src/utils/repository.ts` - 内存仓储基类
- [x] `tests/auth.test.ts` - 认证测试
- [x] `tests/products.test.ts` - 商品测试
- [x] `tests/orders.test.ts` - 订单测试
- [x] `tests/inventory.test.ts` - 库存测试
- [x] `package.json` - 项目配置
- [x] `tsconfig.json` - TypeScript 配置

---

## 10. 状态追踪

| 阶段 | 状态 | 完成时间 | 备注 |
|------|------|---------|------|
| 需求分析 | ✅ 完成 | 2026-07-21 | 本文档 |
| 架构设计 | ✅ 完成 | 2026-07-21 | ARCHITECTURE.md |
| 测试设计 | ✅ 完成 | 2026-07-21 | TEST_PLAN.md |
| 开发实现 | ✅ 完成 | 2026-07-21 | src/ |
| 测试验证 | ✅ 完成 | 2026-07-21 | tests/ |
| 文档对照代码审查 | ✅ 通过 | 2026-07-21 | D1~D6 全部通过 |
