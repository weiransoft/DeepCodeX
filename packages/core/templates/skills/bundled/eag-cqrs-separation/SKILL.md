---
name: eag-cqrs-separation
description: EAG CQRS 读写分离 Skill 包——命令/查询模型分离、事件处理器、投影器模式。Use when 在 cqrs-es 范式的 CODING Loop 阶段唤起，辅助独立开发者实现命令侧与查询侧的分离、事件订阅器、投影器与读模型。仅适用于 cqrs-es 范式。
triggers:
  - CQRS
  - 命令查询分离
  - 事件溯源
  - 投影器
  - 读模型
  - cqrs-es
  - event sourcing
  - projector
  - read model
---

# EAG CQRS 读写分离 Skill 包

本 Skill 包是 EAG（企业应用生成）体系 cqrs-es 范式 CODING Loop 阶段的辅助材料，
为独立开发者角色提供命令/查询分离、事件订阅、投影器实现的结构化指引。

## 适用范围

- **唤起阶段**：CODING Loop（仅 cqrs-es 范式）
- **适用范式**：cqrs-es（CQRS + Event Sourcing）
- **唤起条件**：cqrs-es 范式下 CODING Loop 默认唤起；其他范式不唤起（Token 经济学）

## 核心概念

### CQRS 三要素

1. **命令侧（Command Side）**：处理写操作，执行业务逻辑，产生领域事件
2. **查询侧（Query Side）**：处理读操作，查询反范式化的读模型
3. **事件总线（Event Bus）**：连接命令侧与查询侧，异步传递事件

### Event Sourcing 核心

- 聚合状态以事件流形式持久化（不存储当前状态，存储所有变更事件）
- 重放事件流可重建聚合状态（支持时间旅行查询）
- 事件是不可变的事实记录（审计依据）

## 核心方法

### 方法 1：命令/查询模型分离

**规则 1：命令侧不得读查询侧**
- 命令处理器（CommandHandler）不得直接调用 ReadModelRepository。
- 命令侧通过聚合根重放事件获取状态（对应 DEP-CMD-Q-01 依赖规则）。

**规则 2：查询侧不得改命令侧**
- 投影器（Projector）不得调用聚合根的写方法（对应 DEP-PROJ-01 依赖规则）。
- 查询侧是只读消费者，仅订阅事件并更新读模型。

**规则 3：读写模型独立演化**
- 读模型可按查询需求反范式化（如订单列表预聚合用户名、商品名）
- 写模型保持规范化（聚合根不变式优先）

**命令处理器模板**：

```typescript
// 命令（表达意图，不可变）
export class CreateOrderCommand {
  constructor(
    readonly customerId: string,
    readonly items: Array<{ productId: string; quantity: number }>
  ) {}
}

// 命令处理器
export class CreateOrderCommandHandler {
  constructor(
    private readonly eventStore: EventStore,    // 事件存储
    private readonly eventBus: EventBus          // 事件总线
  ) {}

  async handle(cmd: CreateOrderCommand): Promise<string> {
    // 步骤 1：从事件存储重建聚合（若有历史事件）
    const events = await this.eventStore.loadEvents(cmd.aggregateId);
    const order = OrderAggregate.replay(events);

    // 步骤 2：执行业务方法（聚合根产生新事件）
    const newEvents = order.create(cmd);  // 不直接修改状态，仅产生事件

    // 步骤 3：持久化新事件到事件存储
    await this.eventStore.appendEvents(order.id, newEvents);

    // 步骤 4：发布事件到事件总线（异步通知投影器）
    await this.eventBus.publish(newEvents);

    return order.id;
  }
}
```

### 方法 2：事件处理器实现

事件处理器（Event Handler）订阅事件总线，处理特定类型的事件。常见用途：
- 投影器：更新读模型
- 通知器：发送邮件/短信
- Saga 触发器：触发跨服务事务

**事件处理器模板**：

```typescript
// 事件处理器接口
export interface EventHandler<TEvent extends DomainEvent> {
  eventType: string;                // 订阅的事件类型
  handle(event: TEvent): Promise<void>;
}

// 投影器（更新读模型的事件处理器）
export class OrderProjection implements EventHandler<OrderPlacedEvent> {
  eventType = 'OrderPlacedEvent';

  constructor(private readonly readModelRepo: OrderReadModelRepository) {}

  async handle(event: OrderPlacedEvent): Promise<void> {
    // 幂等控制：检查事件是否已处理（事件 ID + 处理记录表）
    const processed = await this.readModelRepo.isEventProcessed(event.eventId);
    if (processed) return;

    // 更新读模型（反范式化：预聚合用户名、商品名等）
    const readModel = new OrderReadModel(
      event.aggregateId,
      event.customerId,
      event.customerName,    // 反范式化字段
      event.totalAmount,
      event.placedAt
    );
    await this.readModelRepo.upsert(readModel);

    // 标记事件已处理（幂等保证）
    await this.readModelRepo.markEventProcessed(event.eventId);
  }
}
```

### 方法 3：投影器与读模型

投影器（Projector）是事件订阅器，负责将事件流转换为读模型。读模型设计要点：

**规则 1：读模型按查询需求设计**
- 列表查询：预聚合关联数据（如订单列表预聚合用户名、商品名）
- 详情查询：保留原始字段（如订单详情含完整行项目）
- 报表查询：预计算聚合值（如月度销售额）

**规则 2：读模型可独立扩展**
- 每个查询场景一个读模型（OrderListReadModel、OrderDetailReadModel、OrderMonthlyStatsReadModel）
- 读模型存储可异构（关系型数据库 / Elasticsearch / Redis）

**规则 3：投影器必须幂等**
- 事件可能重放（事件溯源的核心特性），投影器必须支持重复处理
- 实现方式：事件 ID + 处理记录表去重；或天然幂等的 upsert 操作

**读模型存储模板**：

```typescript
// 读模型（反范式化，按查询需求设计）
export class OrderListReadModel {
  constructor(
    readonly orderId: string,
    readonly customerId: string,
    readonly customerName: string,      // 反范式化（避免查询时关联用户表）
    readonly totalAmount: number,
    readonly status: string,
    readonly placedAt: Date
  ) {}
}

// 读模型仓储
export interface OrderReadModelRepository {
  upsert(model: OrderListReadModel): Promise<void>;
  findByCustomerId(customerId: string): Promise<OrderListReadModel[]>;
  isEventProcessed(eventId: string): Promise<boolean>;
  markEventProcessed(eventId: string): Promise<void>;
}
```

## 输出契约

cqrs-es 范式 CODING Loop 产出：
- 命令侧：聚合根 + 命令 + 命令处理器 + 事件存储实现
- 查询侧：读模型 + 仓储 + 投影器 + 查询 API
- 共享：领域事件定义 + 事件总线实现

## 与 EAG 红线的关系

- E1 事务边界：聚合内事件强一致，跨聚合通过事件最终一致
- E2 幂等性：事件处理器必须幂等（事件 ID 去重）
- E3 审计：事件流是天然审计依据（事件溯源即审计）
- E4 依赖方向：命令侧不得依赖查询侧（DEP-CMD-Q-01）

## 反模式警告

- **命令侧直接查询**：CommandHandler 调用 ReadModelRepository（AP-CMD-QUERY-01）
- **事件缺失幂等**：投影器未做幂等控制，重放时数据累加（AP-NO-IDEMP-01）
- **聚合状态直接修改**：绕过事件应用方法，事件流无法重建状态（AP-AGG-MUT-01）
- **投影器修改聚合**：投影器调用命令侧聚合方法（AP-PROJ-MUT-AGG-01）
- **缺少快照策略**：事件流过长未做快照，重建耗时（AP-SNAP-MISS-01）
