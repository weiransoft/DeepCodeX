# 订单管理服务任务分解（expected-tasks.md）

> 本文件作为 E2E 测试场景 2（CODING Loop）的期望 TaskDag 参考。
> 测试采用结构性断言（任务数 ≥1 / 4 阶段覆盖），不要求内容 100% 一致。

## 任务卡：T-001 设计阶段 - 用户管理领域建模

- 阶段：DESIGN
- 模块：UserAggregate
- 验收命令：npm run test -- user.aggregate.test.ts
- 声明符号：src/user/user.aggregate.ts:UserAggregate.register

## 任务卡：T-002 设计阶段 - 商品管理领域建模

- 阶段：DESIGN
- 模块：ProductAggregate
- 验收命令：npm run test -- product.aggregate.test.ts
- 声明符号：src/product/product.aggregate.ts:ProductAggregate.create

## 任务卡：T-003 编码阶段 - 订单聚合根实现

- 阶段：CODING
- 模块：OrderAggregate
- 文件簇：OrderAggregate
- 验收命令：npm run test -- order.aggregate.test.ts
- 声明符号：src/order/order.aggregate.ts:OrderAggregate.create

## 任务卡：T-004 编码阶段 - 支付聚合根实现

- 阶段：CODING
- 模块：PaymentAggregate
- 文件簇：PaymentAggregate
- 验收命令：npm run test -- payment.aggregate.test.ts
- 声明符号：src/payment/payment.aggregate.ts:PaymentAggregate.initiate

## 任务卡：T-005 测试阶段 - 契约测试与 E2E 测试

- 阶段：TESTING
- 模块：跨模块
- 验收命令：npm test
- 声明符号：tests/contract/order.contract.test.ts

## 任务卡：T-006 交付阶段 - 交接文档生成

- 阶段：HANDOVER
- 模块：跨模块
- 验收命令：npm run handover:generate
- 声明符号：docs/handover/handover.md
