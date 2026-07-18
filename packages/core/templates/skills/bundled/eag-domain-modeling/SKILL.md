---
name: eag-domain-modeling
description: EAG 领域建模 Skill 包——聚合边界划分五问、实体/值对象判别树、领域事件提取法。Use when 在 DESIGN Loop 领域建模阶段唤起，辅助架构师从原始需求识别聚合/实体/值对象/领域事件，适用于全部 4 个范式（DDD 分层/Clean Architecture/CQRS-ES/微服务）。
triggers:
  - 领域建模
  - 聚合划分
  - 实体识别
  - 值对象识别
  - 领域事件提取
  - DESIGN Loop
  - 限界上下文
  - bounded context
---

# EAG 领域建模 Skill 包

本 Skill 包是 EAG（企业应用生成）体系 DESIGN Loop 领域建模阶段的辅助材料，
为架构师角色提供从原始业务需求识别 DDD 战术构件（聚合/实体/值对象/领域事件）的
结构化方法。

## 适用范围

- **唤起阶段**：DESIGN Loop 领域建模子阶段
- **适用范式**：全部 4 个范式（ddd-layered / clean-architecture / cqrs-es / microservice）
- **唤起条件**：DESIGN Loop 进入领域建模阶段时默认唤起

## 核心方法

### 方法 1：聚合边界划分五问

聚合边界划分是 DDD 建模的核心难点。从原始需求识别聚合时，依次回答五个问题：

**Q1. 一致性边界在哪里？**
- 找出"必须同时一致"的字段集合——若两个字段必须在同一事务内变更，它们应属同一聚合。
- 例：订单的"金额"与"状态"在状态转换时必须同步更新（如已支付→已发货时金额不可变），属于同一 OrderAggregate。

**Q2. 谁是聚合根？**
- 聚合根是聚合对外唯一的访问入口——外部对象只能持有聚合根的引用，不能直接引用聚合内其他对象。
- 例：OrderAggregate 是聚合根，OrderLineEntity 是聚合内实体，外部通过 OrderAggregate.addLine() 操作 OrderLineEntity。

**Q3. 跨聚合如何引用？**
- 聚合间通过 ID 引用（如 OrderAggregate 持有 UserId 而非 UserAggregate 引用），不可直接对象引用。
- 跨聚合变更通过领域事件 + 事件处理器异步完成（对应 E1 红线事务边界）。

**Q4. 聚合大小是否合理？**
- 聚合应尽量小——大聚合导致事务锁竞争激烈、并发性能差。
- 默认优先拆分为小聚合 + 领域事件，仅当一致性要求极高时才合并为大聚合。

**Q5. 该聚合承载哪些不变式？**
- 不变式是聚合必须保持的业务规则（如"订单总金额 = 各行小计之和"）。
- 不变式应在聚合根方法中断言，违反时抛出 DomainError。

### 方法 2：实体 vs 值对象判别树

识别领域对象时，按以下判别树确定是实体（Entity）还是值对象（Value Object）：

```
领域对象
  │
  ├─ 是否有唯一标识（ID）？
  │    │
  │    ├─ 是 → 候选实体
  │    │    │
  │    │    └─ 标识是否独立于属性？（即两个属性完全相同的实体仍视为不同）
  │    │         │
  │    │         ├─ 是 → 实体（Entity）
  │    │         │       例：OrderEntity（订单 ID 不同即使内容相同也是不同订单）
  │    │         │
  │    │         └─ 否 → 值对象（按属性判等）
  │    │                 例：AddressValueObject（相同地址视为同一地址）
  │    │
  │    └─ 否 → 值对象（Value Object）
  │             例：MoneyVO（金额 + 币种，按值判等）
  │
  └─ 是否可变？
       │
       ├─ 不可变 → 值对象（强制不可变，每次修改返回新实例）
       │           例：MoneyVO.add(other) 返回新 MoneyVO，原实例不变
       │
       └─ 可变 → 实体
                 例：OrderEntity.markPaid() 修改自身状态
```

**判别要点**：
- 实体：有唯一标识、可变、按标识判等
- 值对象：无标识（或标识由属性决定）、不可变、按属性判等

### 方法 3：领域事件提取法

领域事件（Domain Event）描述"已经发生的业务事实"，用于跨聚合通信与审计。提取流程：

**Step 1：扫描"业务动作"**
- 从需求中识别所有业务动作（动词短语）：下单、支付、发货、退款、注册、改密...

**Step 2：转换为"已发生事实"**
- 业务动作 → 过去式事件名：下单 → OrderPlacedEvent；支付 → OrderPaidEvent
- 注意时态：事件描述已发生的事实，使用过去式

**Step 3：判定是否需要跨聚合通信**
- 若动作仅影响单一聚合内部状态（如 OrderAggregate.markPaid()），事件可选（仅用于审计）
- 若动作需要触发其他聚合/服务的变更（如支付后扣库存），事件必填

**Step 4：定义事件 schema**
- 事件名、发生时间、聚合 ID、操作者、变更前后快照
- 事件是不可变的，发布后不可修改

**Step 5：识别事件订阅者**
- 每个事件列出订阅者（投影器、事件处理器、其他聚合的事件处理器）

## 输出契约

DESIGN Loop 领域建模阶段产出 `DOMAIN-MODEL.md`，包含：

```markdown
# 领域模型

## 限界上下文清单
- 订单上下文（Order Context）
- 用户上下文（User Context）
- 库存上下文（Inventory Context）

## 聚合清单
### OrderAggregate（订单聚合根）
- 不变式：订单总金额 = Σ(行小计)；状态转换必须遵循 [created → paid → shipped → delivered]
- 聚合内实体：OrderLineEntity
- 聚合内值对象：MoneyVO, AddressVO
- 领域事件：OrderPlacedEvent, OrderPaidEvent, OrderShippedEvent

## 跨聚合引用
- OrderAggregate.userId → UserId（引用用户聚合）
- OrderAggregate.inventoryItems → InventoryItemId[]（引用库存聚合）

## 领域事件清单
| 事件名 | 发布者 | 订阅者 | 触发条件 |
|-------|-------|-------|---------|
| OrderPaidEvent | OrderAggregate | InventoryProjection, NotificationService | 订单支付成功后 |
```

## 与 EAG 红线的关系

- E1 事务边界：聚合边界即事务边界，跨聚合变更必须通过事件异步
- E3 审计：领域事件是审计依据，状态变更必须发布事件
- E7 贫血模型禁令：聚合根与实体必须内聚业务方法，避免贫血

## 反模式警告

- **大聚合反模式**：将整个业务域塞入单一聚合，导致事务锁竞争
- **跨聚合直接引用**：聚合根持有其他聚合根的对象引用（应改为 ID 引用）
- **事件未做幂等**：事件订阅者未做幂等控制，重放时数据累加
- **值对象可变**：值对象提供 setter 破坏不可变性约束
