---
name: eag-aggregate-design
description: EAG 聚合设计 Skill 包——聚合内一致性规则、工厂方法、仓储接口归属。Use when 在 CODING Loop 战术实现阶段唤起，辅助独立开发者实现聚合根内部不变式、工厂构造、仓储接口定义，适用于全部 4 个范式（DDD 分层/Clean Architecture/CQRS-ES/微服务）。
triggers:
  - 聚合设计
  - 聚合根实现
  - 工厂方法
  - 仓储接口
  - 不变式
  - CODING Loop
  - 战术实现
  - aggregate root
---

# EAG 聚合设计 Skill 包

本 Skill 包是 EAG（企业应用生成）体系 CODING Loop 战术实现阶段的辅助材料，
为独立开发者角色提供聚合根内部实现的结构化指引。

## 适用范围

- **唤起阶段**：CODING Loop 战术实现阶段
- **适用范式**：全部 4 个范式（ddd-layered / clean-architecture / cqrs-es / microservice）
- **唤起条件**：CODING Loop 实现聚合根时默认唤起

## 核心方法

### 方法 1：聚合内一致性规则

聚合根的核心职责是维护聚合内一致性不变式。实现规则：

**规则 1：所有变更通过聚合根方法**
- 聚合内实体的状态变更必须通过聚合根方法触发，禁止外部直接修改。
- 例：OrderLineEntity.setQuantity() 设为 internal/private，外部通过 OrderAggregate.updateLineQuantity(lineId, qty) 调用。

**规则 2：变更前断言不变式**
- 聚合根方法在执行变更前必须断言不变式，违反时抛出 DomainError。
- 例：OrderAggregate.markPaid() 必须先断言 `status === "created"`，否则抛出 InvalidStatusTransitionError。

**规则 3：变更后发布领域事件**
- 状态变更后必须发布领域事件（对应 E3 审计红线）。
- 事件应在事务提交后异步发布（避免事务回滚但事件已发）。

**规则 4：构造即验证**
- 聚合根构造函数/工厂方法必须断言所有必填字段与初始不变式（对应 E5 输入校验红线）。
- 例：OrderAggregate.create() 必须断言 `customerId != null` 且 `items.length > 0`。

### 方法 2：工厂方法模式

聚合根的构造应通过工厂方法而非直接 `new`，原因：
- 直接 `new` 可能绕过不变式断言（如未设置必填字段）
- 工厂方法封装复杂构造逻辑（如根据 DTO 创建聚合根 + 内部实体集合）

**工厂方法实现模板**：

```typescript
// 聚合根工厂方法（TypeScript 示例）
export class OrderAggregate {
  // 私有构造函数——禁止外部 new
  private constructor(
    private readonly id: OrderId,
    private readonly customerId: CustomerId,
    private readonly items: OrderLineEntity[],
    private status: OrderStatus,
    private totalAmount: MoneyVO
  ) {}

  // 工厂方法——封装构造与不变式断言
  static create(command: CreateOrderCommand): OrderAggregate {
    // 断言必填字段
    if (!command.customerId) throw new DomainError('customerId 必填');
    if (command.items.length === 0) throw new DomainError('订单必须包含至少一行');

    // 计算初始总金额（不变式：totalAmount = Σ(行小计)）
    const totalAmount = command.items.reduce(
      (sum, item) => sum.add(item.subTotal),
      MoneyVO.zero()
    );

    // 构造聚合根
    const order = new OrderAggregate(
      OrderId.generate(),
      command.customerId,
      command.items,
      OrderStatus.CREATED,
      totalAmount
    );

    // 发布领域事件
    order.recordEvent(new OrderPlacedEvent(order.id, order.customerId, order.totalAmount));
    return order;
  }
}
```

**Java/Python/Go 实现要点**：
- Java：私有构造 + 静态工厂方法
- Python：私有 `__init__` + classmethod 工厂方法
- Go：私有结构体字段 + 大写工厂函数（如 `NewOrderAggregate()`）

### 方法 3：仓储接口归属

仓储接口是聚合根持久化的抽象，归属规则：

**规则 1：仓储接口定义在领域层**
- 仓储接口属于 domain 层（DDD 分层）/ entities 或 use-cases 层（Clean Architecture）。
- 接口仅声明 CRUD 方法，不涉及具体持久化技术。

**规则 2：仓储实现定义在基础设施层**
- 仓储实现属于 infrastructure 层（DDD 分层）/ frameworks 层（Clean Architecture）。
- 实现封装 ORM/数据库访问，实现领域层定义的接口。

**规则 3：应用层通过依赖注入使用仓储**
- Application Service 通过构造函数注入仓储接口，运行期由 DI 容器注入实现。
- 禁止 Application Service 直接 `new` 仓储实现（违反依赖反转）。

**仓储接口模板**：

```typescript
// 仓储接口（定义在 domain/repositories/）
export interface OrderRepository {
  findById(id: OrderId): Promise<OrderAggregate | null>;
  save(order: OrderAggregate): Promise<void>;
  delete(id: OrderId): Promise<void>;
}

// 仓储实现（定义在 infrastructure/persistence/）
export class OrderRepositoryImpl implements OrderRepository {
  constructor(private readonly db: Database) {}
  async findById(id: OrderId): Promise<OrderAggregate | null> { /* ... */ }
  async save(order: OrderAggregate): Promise<void> { /* ... */ }
  async delete(id: OrderId): Promise<void> { /* ... */ }
}

// 应用层使用（依赖注入）
export class OrderApplicationService {
  constructor(private readonly orderRepo: OrderRepository) {}  // 注入接口
  async placeOrder(cmd: CreateOrderCommand): Promise<OrderId> {
    const order = OrderAggregate.create(cmd);
    await this.orderRepo.save(order);
    return order.id;
  }
}
```

## 输出契约

CODING Loop 战术实现阶段产出：
- 聚合根类（含工厂方法 + 不变式断言 + 状态转换方法）
- 聚合内实体类（字段 + 内部状态变更方法）
- 值对象类（不可变 + 按值判等 + equals 方法）
- 仓储接口（domain 层）+ 仓储实现（infrastructure 层）

## 与 EAG 红线的关系

- E1 事务边界：聚合根方法内一致性强，跨聚合通过事件最终一致
- E3 审计：状态变更方法必须发布领域事件
- E5 输入校验：工厂方法断言必填字段与不变式
- E7 贫血模型禁令：聚合根与实体必须内聚业务方法，不可仅 getter/setter

## 反模式警告

- **公共 setter**：聚合根或实体暴露 setter，绕过不变式断言
- **直接 new 聚合根**：绕过工厂方法的验证逻辑
- **仓储定义在应用层**：违反依赖反转原则
- **聚合根继承 ORM 基类**：领域层被持久化框架绑架
- **贫血聚合根**：仅持有字段无业务方法，业务逻辑散落在 Service 层
