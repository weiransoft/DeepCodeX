# 订单管理服务架构设计（expected-architecture.md）

> 本文件作为 E2E 测试场景 1（DESIGN Loop）的期望架构设计参考。
> 测试采用结构性断言（4 层架构 / 4 模块），不要求内容 100% 一致。

## 范式选择

采用 DDD 分层架构（Domain-Driven Design Layered），原因：
- 业务领域复杂度 high（4 个聚合根 + 状态机 + 跨聚合一致性）
- 一致性要求 strong（订单与支付最终一致）
- 读写模式 balanced

## 分层架构

### 1. 领域层（Domain Layer）

- UserAggregate（用户聚合根）：register / login / getProfile
- ProductAggregate（商品聚合根）：create / findById / deductStock
- OrderAggregate（订单聚合根）：create / pay / ship / complete / cancel / refund
- PaymentAggregate（支付聚合根）：initiate / handleCallback / refund

领域事件：
- OrderCreatedEvent
- OrderPaidEvent
- OrderShippedEvent
- OrderCompletedEvent
- OrderCancelledEvent
- OrderRefundedEvent

### 2. 应用层（Application Layer）

- UserApplicationService：用户注册 / 登录应用服务
- ProductApplicationService：商品管理应用服务
- OrderApplicationService：订单管理应用服务（编排订单聚合 + 商品库存扣减 + 支付发起）
- PaymentApplicationService：支付应用服务

### 3. 基础设施层（Infrastructure Layer）

- UserRepositoryImpl（用户仓储实现）
- ProductRepositoryImpl（商品仓储实现）
- OrderRepositoryImpl（订单仓储实现）
- PaymentRepositoryImpl（支付仓储实现）
- JwtTokenService（JWT 令牌服务）
- PaymentGatewayAdapter（支付网关适配器）

### 4. 接口层（Interface Layer）

- UserController（REST 控制器）
- ProductController
- OrderController
- PaymentController
- PaymentCallbackHandler（支付回调处理器）

## 依赖规则

- 接口层 → 应用层 → 领域层
- 基础设施层实现领域层定义的 Port（Repository Port）
- 领域层不依赖任何外层（防止依赖方向反置）
- 跨聚合一致性通过领域事件 + Saga 编排器实现

## 模块边界

- UserAggregate：用户身份与认证
- ProductAggregate：商品信息与库存
- OrderAggregate：订单状态机与流程编排
- PaymentAggregate：支付网关交互与退款

## 技术栈

- 语言：TypeScript
- 运行时：Node.js 22+
- 测试框架：node:test + node:assert/strict
- 模块系统：ESM
