---
name: eag-saga-orchestration
description: EAG Saga 编排 Skill 包——编排式 Saga、补偿动作、幂等消费。Use when 在跨聚合/跨服务事务场景下唤起，辅助独立开发者实现编排式 Saga 模式，包括正向步骤、补偿动作、幂等键控制。适用于 ddd-layered、cqrs-es、microservice 范式。
triggers:
  - Saga
  - 编排式 Saga
  - 补偿动作
  - 跨服务事务
  - 幂等消费
  - 分布式事务
  - 微服务事务
  - compensation
---

# EAG Saga 编排 Skill 包

本 Skill 包是 EAG（企业应用生成）体系跨聚合/跨服务事务场景下的辅助材料，
为独立开发者角色提供编排式 Saga 模式的实现指引。

## 适用范围

- **唤起阶段**：CODING Loop（跨聚合/跨服务事务场景）
- **适用范式**：ddd-layered / cqrs-es / microservice
- **唤起条件**：识别到跨聚合写操作（聚合根 A 的方法触发聚合根 B 的变更）或跨服务事务时唤起

## 核心概念

### Saga 模式

Saga 是跨聚合/跨服务事务的解决方案，将长事务拆分为一系列本地事务：
- 每个本地事务独立提交（避免两阶段提交的性能与可用性问题）
- 任一本地事务失败，执行已成功步骤的补偿动作回滚
- 最终一致性（非强一致）

### 编排式 vs 协同式 Saga

| 类型 | 编排式（Orchestration） | 协同式（Choreography） |
|------|-----------------------|----------------------|
| 决策方 | 中央编排器（Orchestrator） | 各服务自行决策 |
| 复杂度 | 集中管理，适合复杂流程 | 分散管理，适合简单流程 |
| 可观测 | 流程清晰，易追踪 | 流程隐式，难追踪 |
| EAG 推荐 | ✅ 首选 | 复杂度低场景可选 |

EAG 首选**编排式 Saga**——流程集中管理便于审计与调试。

## 核心方法

### 方法 1：编排式 Saga 实现

**Saga 编排器模板**：

```typescript
// Saga 步骤定义
export interface SagaStep<TContext> {
  name: string;
  action: (ctx: TContext) => Promise<void>;       // 正向动作
  compensation: (ctx: TContext) => Promise<void>; // 补偿动作（失败时回滚）
}

// Saga 编排器
export class OrderSaga {
  constructor(
    private readonly steps: SagaStep<OrderContext>[],
    private readonly sagaLog: SagaLog            // Saga 日志（持久化执行状态）
  ) {}

  async execute(ctx: OrderContext): Promise<void> {
    const executedSteps: SagaStep<OrderContext>[] = [];

    try {
      // 顺序执行正向步骤
      for (const step of this.steps) {
        // 幂等控制：检查步骤是否已执行（重试场景）
        const status = await this.sagaLog.getStepStatus(ctx.sagaId, step.name);
        if (status === 'completed') continue;

        await this.sagaLog.markStepStarted(ctx.sagaId, step.name);
        await step.action(ctx);
        await this.sagaLog.markStepCompleted(ctx.sagaId, step.name);
        executedSteps.push(step);
      }
      await this.sagaLog.markSagaCompleted(ctx.sagaId);

    } catch (error) {
      // 执行补偿：逆序执行已成功步骤的补偿动作
      await this.sagaLog.markSagaCompensating(ctx.sagaId);
      for (let i = executedSteps.length - 1; i >= 0; i--) {
        const step = executedSteps[i];
        try {
          await step.compensation(ctx);
          await this.sagaLog.markCompensationCompleted(ctx.sagaId, step.name);
        } catch (compensationError) {
          // 补偿失败：记录日志，人工介入
          await this.sagaLog.markCompensationFailed(ctx.sagaId, step.name, compensationError);
          throw compensationError;
        }
      }
      await this.sagaLog.markSagaFailed(ctx.sagaId, error);
      throw error;
    }
  }
}

// 订单 Saga 示例：下单 → 扣库存 → 扣余额 → 确认订单
const orderSaga = new OrderSaga([
  {
    name: 'createOrder',
    action: async (ctx) => { await orderService.create(ctx.order); },
    compensation: async (ctx) => { await orderService.cancel(ctx.orderId); }
  },
  {
    name: 'deductInventory',
    action: async (ctx) => { await inventoryService.deduct(ctx.items); },
    compensation: async (ctx) => { await inventoryService.restore(ctx.items); }
  },
  {
    name: 'deductBalance',
    action: async (ctx) => { await paymentService.charge(ctx.customerId, ctx.amount); },
    compensation: async (ctx) => { await paymentService.refund(ctx.customerId, ctx.amount); }
  }
], sagaLog);
```

### 方法 2：补偿动作设计

补偿动作（Compensation Action）是 Saga 失败时的回滚操作，设计规则：

**规则 1：每个正向步骤必有补偿**
- 禁止"无补偿 Saga 步骤"（对应 AP-SAGA-NO-COMP-01 反模式）
- 即使是"创建订单"这样的步骤，也需要"取消订单"补偿

**规则 2：补偿必须幂等**
- Saga 可能重试多次，补偿动作可能被执行多次
- 通过幂等键（Idempotency-Key）或天然幂等语义保证（如 upsert）
- 例：退款补偿必须检查"是否已退款"，已退则直接返回成功

**规则 3：补偿动作业务可逆**
- 补偿应在业务语义上回滚（如"取消订单"而非"删除订单记录"）
- 删除是不可逆操作，应用状态标记代替物理删除

**规则 4：补偿失败需人工介入**
- 补偿动作可能失败（外部服务不可用），必须记录失败日志
- 触发告警通知人工介入（无法自动重试时）

### 方法 3：幂等消费实现

Saga 步骤的幂等性是分布式事务可靠性的核心：

**幂等实现方式 1：幂等键 + 去重表**
```typescript
async function deductInventory(cmd: DeductCommand): Promise<void> {
  // 幂等键：cmd.idempotencyKey（由 Saga 编排器生成，唯一标识本次操作）
  const existing = await dedupTable.find(cmd.idempotencyKey);
  if (existing) {
    // 已处理：返回缓存结果（幂等保证）
    return existing.result;
  }

  // 执行业务
  const result = await inventoryService.deduct(cmd.items);

  // 记录幂等键（TTL 设为业务最大重试时间）
  await dedupTable.save(cmd.idempotencyKey, result, { ttl: '24h' });
  return result;
}
```

**幂等实现方式 2：状态机**
- 对于状态转换类操作（如订单状态 created → paid），状态机天然幂等
- 已是 paid 状态时再次调用 markPaid() 直接返回成功

**幂等实现方式 3：乐观锁 + 版本号**
- 通过版本号字段防止重复更新
- `UPDATE orders SET status='paid', version=version+1 WHERE id=? AND version=?`

## 输出契约

Saga 编排 Skill 产出：
- Saga 编排器类（含步骤定义 + 补偿动作）
- Saga 日志持久化（saga_log 表，记录步骤状态）
- 幂等键管理（dedup_table 或 Redis SETNX）
- 补偿动作实现（每个步骤对应一个补偿方法）

## 与 EAG 红线的关系

- E1 事务边界：跨聚合/跨服务写必须通过 Saga
- E2 幂等性：Saga 步骤必须支持幂等键（Idempotency-Key）
- E3 审计：Saga 日志是事务审计依据
- E4 依赖方向：Saga 编排器通过 API 调用服务，不直接 import 服务内部代码（DEP-SAGA-01）

## 反模式警告

- **Saga 缺补偿**：正向步骤无对应补偿动作（AP-SAGA-NO-COMP-01）
- **Saga 步骤缺幂等**：重试时产生重复操作（AP-SAGA-NO-IDEMP-01）
- **补偿动作非幂等**：多次执行补偿导致数据错误
- **补偿动作物理删除**：用 delete 代替业务回滚，丢失审计数据
- **同步调用链过长**：分布式单体，任一服务故障导致整链失败（AP-DIST-MON-01）
