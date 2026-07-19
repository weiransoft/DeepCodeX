# 订单管理服务规格说明（expected-spec.md）

> 本文件作为 E2E 测试场景 1（DESIGN Loop）的期望产出参考。
> 由于 InMemoryLLMClient 生成有随机性，测试采用结构性断言（模块数 ≥4 / 验收标准 ≥3），
> 不要求内容 100% 一致。本文件描述期望的 spec.md 结构与关键内容。

## 项目定位

电商平台订单管理服务，提供用户管理 / 商品管理 / 订单管理 / 支付管理 4 大领域能力。

## 模块清单

### 模块：用户管理（UserAggregate）

- 职责：用户注册 / 登录 / 信息查询
- 关键 API：POST /api/v1/users/register、POST /api/v1/users/login、GET /api/v1/users/{id}
- 验收标准：AC-001 / AC-002

### 模块：商品管理（ProductAggregate）

- 职责：商品创建 / 查询 / 库存扣减
- 关键 API：POST /api/v1/products、GET /api/v1/products/{id}、POST /api/v1/products/{id}/deduct
- 验收标准：AC-003 / AC-004
- 依赖：无

### 模块：订单管理（OrderAggregate）

- 职责：订单创建 / 状态机迁移 / 查询
- 关键 API：POST /api/v1/orders、GET /api/v1/orders/{id}、GET /api/v1/orders?userId={id}
- 验收标准：AC-005
- 依赖：用户管理 / 商品管理

### 模块：支付管理（PaymentAggregate）

- 职责：发起支付 / 异步回调 / 退款
- 关键 API：POST /api/v1/payments、POST /api/v1/payments/callback、POST /api/v1/payments/{id}/refund
- 验收标准：AC-006 / AC-007
- 依赖：订单管理

## 依赖关系图

```
用户管理 ←── 订单管理 ──→ 商品管理
              ↑
              │
            支付管理
```

## 非功能需求

- 性能：P99 ≤200ms
- 并发：≥1000 QPS
- 一致性：订单与支付最终一致（通过领域事件实现）

## 验收标准

- AC-001：用户注册成功返回用户 ID
- AC-002：登录返回 JWT token
- AC-003：商品按 ID 查询返回完整信息
- AC-004：库存不足返回错误
- AC-005：订单状态机迁移符合预期路径
- AC-006：支付回调后订单状态迁移
- AC-007：退款后订单状态为已退款
