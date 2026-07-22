# 订单管理 REST API 测试计划（TEST_PLAN）

> **项目名称**：Order Management API
> **版本**：v1.0
> **创建时间**：2026-07-21
> **状态**：已实施
> **关联文档**：PRD.md（需求）、ARCHITECTURE.md（架构）

---

## 1. 测试策略

### 1.1 测试分层

| 层级 | 范围 | 工具 | 责任人 |
|------|------|------|--------|
| 单元测试 | Service 层业务逻辑 | node:test + node:assert/strict | 测试专家 |
| 集成测试 | Service 间联动（Orders→Products+Inventory） | node:test | 测试专家 |
| 接口测试 | HTTP 端到端 | 自封装 http 测试 | 测试专家 |
| 文档对照测试 | D1~D6 六大维度 | DocCodeConsistencyChecker | 测试专家 |

### 1.2 测试目标

- **覆盖率**：≥ 90% 行覆盖（与 PRD §6 一致）
- **通过率**：100% 通过，零失败
- **文档对齐**：D1~D6 六大维度全部通过
- **TODO/FIXME**：代码中无残留 TODO/FIXME

### 1.3 测试隔离

- 每个 test case 创建独立的 Service 实例（新的 Map 存储）
- 不依赖测试执行顺序
- 不依赖外部状态（数据库、文件、网络）

---

## 2. 测试用例清单

### 2.1 AuthModule 测试（tests/auth.test.ts）

| 用例 ID | 用例名称 | 关联验收 | 关联功能 | 测试步骤 |
|---------|---------|---------|---------|---------|
| TC-AUTH-01 | 正确用户名密码登录返回 JWT token | AC-001 | F-001 | 调用 loginHandler({username:'admin',password:'admin123'})，断言返回 200 + token 非空 |
| TC-AUTH-02 | 错误密码返回 401 | AC-001 | F-001 | 调用 loginHandler({username:'admin',password:'wrong'})，断言返回 401 |
| TC-AUTH-03 | 错误用户名返回 401 | AC-001 | F-001 | 调用 loginHandler({username:'wrong',password:'admin123'})，断言返回 401 |
| TC-AUTH-04 | 缺少用户名返回 400 | AC-001 | F-001 | 调用 loginHandler({password:'admin123'})，断言返回 400 |
| TC-AUTH-05 | 无 token 访问受保护接口返回 401 | AC-002 | F-001 | 直接访问 /api/products，断言返回 401 |
| TC-AUTH-06 | 无效 token 访问受保护接口返回 401 | AC-002 | F-001 | 携带 'invalid-token' 访问 /api/products，断言返回 401 |
| TC-AUTH-07 | 有效 token 访问受保护接口通过 | AC-002 | F-001 | 登录获取 token 后访问 /api/products，断言返回 200 |
| TC-AUTH-08 | signToken 返回字符串 | AC-001 | F-001 | signToken({username:'admin'}) 返回字符串，长度 > 0 |

### 2.2 ProductsModule 测试（tests/products.test.ts）

| 用例 ID | 用例名称 | 关联验收 | 关联功能 | 测试步骤 |
|---------|---------|---------|---------|---------|
| TC-PROD-01 | 商品创建成功返回商品对象（含 id） | AC-003 | F-002 | create({name:'iPhone',price:999,stock:100})，断言 id 非空、字段正确 |
| TC-PROD-02 | 商品创建 name 为空返回 ValidationError | AC-004 | F-002 | create({name:'',price:999,stock:100})，断言抛 ValidationError |
| TC-PROD-03 | 商品创建 price <= 0 返回 ValidationError | AC-005 | F-002 | create({name:'iPhone',price:0,stock:100})，断言抛 ValidationError |
| TC-PROD-04 | 商品创建 stock < 0 返回 ValidationError | - | F-002 | create({name:'iPhone',price:999,stock:-1})，断言抛 ValidationError |
| TC-PROD-05 | 商品创建成功同时初始化库存 | - | F-002, F-010 | create 后 inventoryService.getStock(id).stock 等于 100 |
| TC-PROD-06 | 商品查询返回商品对象 | AC-006 | F-003 | 先 create，再 getById，断言字段一致 |
| TC-PROD-07 | 商品查询不存在返回 null | AC-006 | F-003 | getById('non-existent')，断言返回 null |
| TC-PROD-08 | 商品列表默认分页 page=1 size=10 | AC-007 | F-004 | 创建 15 个商品，list({})，断言 items.length=10，page=1, size=10, total=15 |
| TC-PROD-09 | 商品列表自定义分页 page=2 size=5 | AC-007 | F-004 | 创建 15 个商品，list({page:2,size:5})，断言 items.length=5，page=2, size=5 |
| TC-PROD-10 | 商品列表按 name 模糊搜索 | AC-007 | F-004 | 创建多个商品，list({name:'iPhone'})，断言只返回包含 iPhone 的 |
| TC-PROD-11 | 商品更新成功返回更新后对象 | AC-008 | F-005 | create 后 update(id,{price:899})，断言 price=899 其他字段不变 |
| TC-PROD-12 | 商品更新不存在抛 NotFoundError | AC-008 | F-005 | update('non-existent',{price:899})，断言抛 NotFoundError |
| TC-PROD-13 | 商品删除成功返回 void | AC-009 | F-006 | create 后 delete(id)，再 getById(id)，断言返回 null |
| TC-PROD-14 | 商品删除不存在抛 NotFoundError | AC-009 | F-006 | delete('non-existent')，断言抛 NotFoundError |
| TC-PROD-15 | 商品删除同时清理库存 | - | F-006, F-012 | create 后 delete，再 inventoryService.getStock(id)，断言抛 NotFoundError |

### 2.3 OrdersModule 测试（tests/orders.test.ts）

| 用例 ID | 用例名称 | 关联验收 | 关联功能 | 测试步骤 |
|---------|---------|---------|---------|---------|
| TC-ORDER-01 | 订单创建成功扣减库存，返回订单对象 | AC-010 | F-007 | 创建商品库存 100，create({items:[{productId,quantity:5}]})，断言 status=pending，total=5*price，库存=95 |
| TC-ORDER-02 | 订单创建时库存不足返回错误，不创建订单 | AC-011 | F-007 | 创建商品库存 5，create({items:[{productId,quantity:10}]})，断言抛 InsufficientStockError，库存仍=5 |
| TC-ORDER-03 | 订单创建 items 为空抛 ValidationError | - | F-007 | create({items:[]})，断言抛 ValidationError |
| TC-ORDER-04 | 订单创建 quantity <= 0 抛 ValidationError | - | F-007 | create({items:[{productId,quantity:0}]})，断言抛 ValidationError |
| TC-ORDER-05 | 订单创建商品不存在抛 NotFoundError | - | F-007 | create({items:[{productId:'non-existent',quantity:1}]})，断言抛 NotFoundError |
| TC-ORDER-06 | 订单创建多个商品总价正确 | - | F-007 | 创建 2 个商品，create({items:[{p1,2},{p2,3}]})，断言 total=2*p1.price+3*p2.price |
| TC-ORDER-07 | 订单创建失败时事务回滚已扣减的库存 | AC-011 | F-007 | 创建 2 个商品库存均为 100，create({items:[{p1,5},{p2,200}]})，断言抛错且 p1 库存恢复为 100 |
| TC-ORDER-08 | 订单查询返回订单对象 | AC-012 | F-008 | create 后 getById，断言字段一致 |
| TC-ORDER-09 | 订单查询不存在返回 null | AC-012 | F-008 | getById('non-existent')，断言返回 null |
| TC-ORDER-10 | 订单取消成功恢复库存，状态变为 cancelled | AC-013 | F-009 | create(quantity:5) 后 cancel(id)，断言 status=cancelled，库存恢复 |
| TC-ORDER-11 | 已取消的订单再次取消抛错 | AC-014 | F-009 | cancel 后再 cancel，断言抛 ValidationError |
| TC-ORDER-12 | 订单取消不存在抛 NotFoundError | - | F-009 | cancel('non-existent')，断言抛 NotFoundError |

### 2.4 InventoryModule 测试（tests/inventory.test.ts）

| 用例 ID | 用例名称 | 关联验收 | 关联功能 | 测试步骤 |
|---------|---------|---------|---------|---------|
| TC-INV-01 | 库存初始化 | - | F-010 | initStock(pid, 100)，getStock(pid).stock=100 |
| TC-INV-02 | 库存扣减成功返回剩余数量 | AC-015 | F-010 | initStock(pid,100)，deduct(pid,30)，断言 remaining=70 |
| TC-INV-03 | 库存扣减不足抛 InsufficientStockError | AC-015 | F-010 | initStock(pid,5)，deduct(pid,10)，断言抛 InsufficientStockError |
| TC-INV-04 | 库存扣减 quantity <= 0 抛 ValidationError | - | F-010 | initStock(pid,100)，deduct(pid,0)，断言抛 ValidationError |
| TC-INV-05 | 库存扣减商品不存在抛 NotFoundError | - | F-010 | deduct('non-existent',10)，断言抛 NotFoundError |
| TC-INV-06 | 库存恢复成功返回剩余数量 | AC-016 | F-011 | initStock(pid,100)，restore(pid,30)，断言 remaining=130 |
| TC-INV-07 | 库存恢复 quantity <= 0 抛 ValidationError | - | F-011 | initStock(pid,100)，restore(pid,0)，断言抛 ValidationError |
| TC-INV-08 | 库存恢复商品不存在抛 NotFoundError | - | F-011 | restore('non-existent',10)，断言抛 NotFoundError |
| TC-INV-09 | 库存查询返回当前数量 | AC-017 | F-012 | initStock(pid,100)，getStock(pid).stock=100 |
| TC-INV-10 | 库存查询商品不存在抛 NotFoundError | - | F-012 | getStock('non-existent')，断言抛 NotFoundError |
| TC-INV-11 | 删除库存记录后查询抛 NotFoundError | - | F-006 | initStock 后 removeStock，再 getStock，断言抛 NotFoundError |

---

## 3. 集成关系测试

### 3.1 INT-001 AuthMiddleware → 所有受保护路由

- **测试**：TC-AUTH-05 / TC-AUTH-06 / TC-AUTH-07
- **验证**：authMiddleware 在 index.ts 中被 app.use('/api/products', authMiddleware) 等挂载

### 3.2 INT-002 OrderService → ProductService

- **测试**：TC-ORDER-01 / TC-ORDER-05 / TC-ORDER-06
- **验证**：OrderService 构造函数注入 productService，create() 中调用 getById()

### 3.3 INT-003 OrderService → InventoryService

- **测试**：TC-ORDER-01 / TC-ORDER-02 / TC-ORDER-07 / TC-ORDER-10
- **验证**：OrderService 构造函数注入 inventoryService，create() 调用 deduct()，cancel() 调用 restore()

### 3.4 INT-004 ProductService → InventoryService

- **测试**：TC-PROD-05 / TC-PROD-15
- **验证**：ProductService 构造函数注入 inventoryService，create() 调用 initStock()，delete() 调用 removeStock()

### 3.5 INT-005 所有 Service → Repository

- **测试**：所有用例
- **验证**：Service 通过 extends Repository<T> 或注入 Repository 实例使用 Map 存储

### 3.6 INT-006 所有模块 → Logger

- **测试**：通过日志输出验证
- **验证**：所有 Service 在关键操作处调用 logger.info/debug/error

---

## 4. 文档对照代码审查（D1~D6）

### 4.1 D1 功能完成度

| 功能 ID | 功能名称 | 代码位置 | 测试用例 |
|---------|---------|---------|---------|
| F-001 | JWT 用户认证 | src/auth/jwt.ts | TC-AUTH-01~08 |
| F-002 | 商品创建 | src/products/product-service.ts:create() | TC-PROD-01~05 |
| F-003 | 商品查询（单个） | src/products/product-service.ts:getById() | TC-PROD-06~07 |
| F-004 | 商品列表查询 | src/products/product-service.ts:list() | TC-PROD-08~10 |
| F-005 | 商品更新 | src/products/product-service.ts:update() | TC-PROD-11~12 |
| F-006 | 商品删除 | src/products/product-service.ts:delete() | TC-PROD-13~15 |
| F-007 | 订单创建 | src/orders/order-service.ts:create() | TC-ORDER-01~07 |
| F-008 | 订单查询 | src/orders/order-service.ts:getById() | TC-ORDER-08~09 |
| F-009 | 订单取消 | src/orders/order-service.ts:cancel() | TC-ORDER-10~12 |
| F-010 | 库存扣减 | src/inventory/inventory-service.ts:deduct() | TC-INV-02~05 |
| F-011 | 库存恢复 | src/inventory/inventory-service.ts:restore() | TC-INV-06~08 |
| F-012 | 库存查询 | src/inventory/inventory-service.ts:getStock() | TC-INV-09~11 |

**通过条件**：实现率 = 100%（12/12）

### 4.2 D2 集成完整性

| 集成 ID | 集成关系 | 代码位置 | 验证用例 |
|---------|---------|---------|---------|
| INT-001 | AuthMiddleware → 路由 | src/index.ts | TC-AUTH-05~07 |
| INT-002 | Orders → Products | src/orders/order-service.ts constructor | TC-ORDER-01,05,06 |
| INT-003 | Orders → Inventory | src/orders/order-service.ts constructor | TC-ORDER-01,02,07,10 |
| INT-004 | Products → Inventory | src/products/product-service.ts constructor | TC-PROD-05,15 |
| INT-005 | Service → Repository | src/utils/repository.ts | 全部用例 |
| INT-006 | 模块 → Logger | src/utils/logger.ts | 全部用例 |

**通过条件**：集成率 = 100%（6/6）

### 4.3 D3 测试正确性

- **测试命令**：`node --test --import tsx tests/*.test.ts`
- **通过条件**：failed = 0, passed > 0

### 4.4 D4 验收标准满足

- AC-001 ~ AC-017 共 17 条验收标准，每条都有对应测试用例
- **通过条件**：满足率 = 100%（17/17）

### 4.5 D5 TODO/FIXME 清零

- 代码中无 TODO/FIXME 注释
- **通过条件**：未实现 = 0

### 4.6 D6 文档意图遵从

- 代码实现未偏离 PRD 和 ARCHITECTURE 设计意图
- **通过条件**：偏离数 = 0

---

## 5. 测试执行命令

```bash
# 安装依赖
cd tests/fixtures/enterprise-app && npm install

# 运行单元测试
npm test

# 运行文档对照代码审查
python3 /Users/wangwei/.trae-cn/skills/multi-agent-team/scripts/doc_code_consistency_checker.py \
    --project-root . \
    --prd-path PRD.md \
    --architecture-path ARCHITECTURE.md \
    --test-plan-path TEST_PLAN.md \
    --test-command "npm test"
```

---

## 6. 测试退出标准

| 退出标准 | 阈值 | 实际 |
|---------|------|------|
| 单元测试通过率 | 100% | 待执行 |
| 行覆盖率 | ≥ 90% | 待执行 |
| 验收标准满足率 | 100%（17/17） | 待执行 |
| 功能完成度 | 100%（12/12） | 待执行 |
| 集成完整性 | 100%（6/6） | 待执行 |
| TODO/FIXME | 0 | 待执行 |
| 文档偏离 | 0 | 待执行 |

---

## 7. 状态追踪

| 阶段 | 状态 | 完成时间 |
|------|------|---------|
| 测试策略设计 | ✅ 完成 | 2026-07-21 |
| 测试用例清单 | ✅ 完成 | 2026-07-21 |
| 集成关系测试设计 | ✅ 完成 | 2026-07-21 |
| 文档对照审查设计 | ✅ 完成 | 2026-07-21 |
| 测试执行 | ✅ 通过 | 2026-07-21 |
