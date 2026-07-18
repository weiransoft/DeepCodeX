/**
 * 范式定义：微服务架构（Microservice Architecture）
 *
 * 本模块定义 EAG 方案 §5.1.1 首版 4 范式之一的微服务架构。
 *
 * 范式核心：
 * - 服务边界 = 限界上下文（Bounded Context）：每个服务对应一个领域边界
 * - API Gateway：统一入口，负责路由、鉴权、限流、聚合
 * - Saga 编排跨服务事务：通过补偿动作实现最终一致性
 * - 服务间通信：仅通过 API（同步）或事件（异步），禁止数据库共享
 * - 适用场景：多系统集成、团队规模化、读写悬殊、最终一致可接受
 *
 * 设计依据：
 * - EAG 方案 §5.1.1 范式库表格 microservice 行
 * - Newman《Building Microservices》、Richardson《Microservices Patterns》
 *
 * 与单体架构的差异：
 * - 服务可独立部署、独立演进、独立扩展
 * - 每服务独立数据库（或独立 schema），避免数据库耦合
 * - 跨服务事务通过 Saga 而非分布式事务（避免两阶段提交的性能与可用性问题）
 * - 服务间通过 API 契约解耦，支持异构技术栈
 *
 * 不可变保证：
 * - 所有字段 readonly
 * - 顶层常量 Object.freeze 冻结
 * - 对齐 §5.12.4 G-A6d 配置冻结原则
 *
 * @module eag/eak/paradigms/microservice
 */

import type { ArchitectureParadigm } from "../types";

/**
 * 微服务架构范式定义常量
 *
 * 使用 Object.freeze 冻结，作为评估器判定与骨架生成器的输入数据。
 * 修改本常量需走架构变更评审流程。
 *
 * 实现说明：先以字面量对象 + `satisfies ArchitectureParadigm` 做完整类型校验
 * 并保留字面量类型（避免 TS widen 为 string），再 Object.freeze 冻结。
 */
const _MICROSERVICE_PARADIGM = {
  id: "microservice",
  name: "微服务架构",
  description:
    "服务边界对应限界上下文（Bounded Context），每服务独立部署、独立数据库。" +
    "通过 API Gateway 统一入口，Saga 编排跨服务事务实现最终一致性。" +
    "服务间仅通过 API（同步）或事件（异步）通信，禁止数据库共享。" +
    "适用于多系统集成、团队规模化、需要独立扩展的场景。",

  // 适用信号：业务复杂度高、最终一致可接受、读写悬殊、多系统集成
  applicabilitySignals: {
    domainComplexity: "high",
    consistencyRequirement: "eventual",
    readWritePattern: "read-heavy",
    integrationComplexity: "many-systems",
  },

  // 多语言骨架模板：TypeScript/Java/Python/Go 四语言
  // 每服务独立目录，外层 Gateway + Saga + Shared
  skeletonTemplates: [
    {
      language: "typescript",
      // 顶层目录：gateway / saga / services / shared
      directories: [
        "src/gateway/api",
        "src/gateway/middleware",
        "src/saga/orchestrators",
        "src/saga/compensations",
        "src/services/order/api",
        "src/services/order/application",
        "src/services/order/domain",
        "src/services/order/infrastructure",
        "src/services/user/api",
        "src/services/user/application",
        "src/services/user/domain",
        "src/services/user/infrastructure",
        "src/shared/events",
        "src/shared/contracts",
      ],
      entryFiles: [
        { path: "src/gateway/api/gateway.ts", purpose: "API Gateway 入口，统一路由、鉴权、限流、聚合" },
        {
          path: "src/saga/orchestrators/order-saga.ts",
          purpose: "订单 Saga 编排器，协调跨服务事务（如下单扣库存+扣余额）",
        },
        { path: "src/saga/compensations/compensation-action.ts", purpose: "补偿动作实现，Saga 失败时回滚已执行步骤" },
        { path: "src/services/order/api/handler.ts", purpose: "订单服务 API 处理器，仅做请求/响应转换" },
        { path: "src/services/order/domain/aggregate.ts", purpose: "订单服务聚合根，封装订单领域逻辑" },
        { path: "src/shared/events/event-bus.ts", purpose: "事件总线（Kafka/RabbitMQ），服务间异步通信" },
      ],
      configFile: "tsconfig.json",
    },
    {
      language: "java",
      directories: [
        "src/main/java/com/example/gateway/api",
        "src/main/java/com/example/gateway/middleware",
        "src/main/java/com/example/saga/orchestrators",
        "src/main/java/com/example/saga/compensations",
        "src/main/java/com/example/services/order/api",
        "src/main/java/com/example/services/order/application",
        "src/main/java/com/example/services/order/domain",
        "src/main/java/com/example/services/order/infrastructure",
        "src/main/java/com/example/services/user/api",
        "src/main/java/com/example/services/user/application",
        "src/main/java/com/example/services/user/domain",
        "src/main/java/com/example/services/user/infrastructure",
        "src/main/java/com/example/shared/events",
        "src/main/java/com/example/shared/contracts",
      ],
      entryFiles: [
        {
          path: "src/main/java/com/example/gateway/api/GatewayApplication.java",
          purpose: "Spring Cloud Gateway 入口，统一路由、鉴权、限流",
        },
        {
          path: "src/main/java/com/example/saga/orchestrators/OrderSaga.java",
          purpose: "订单 Saga 编排器，协调跨服务事务",
        },
        { path: "src/main/java/com/example/saga/compensations/CompensationAction.java", purpose: "补偿动作接口与实现" },
        { path: "src/main/java/com/example/services/order/api/OrderController.java", purpose: "订单服务 REST 控制器" },
        { path: "src/main/java/com/example/services/order/domain/OrderAggregate.java", purpose: "订单服务聚合根" },
        { path: "src/main/java/com/example/shared/events/EventBus.java", purpose: "事件总线抽象，封装 Kafka/RabbitMQ" },
      ],
      configFile: "pom.xml",
    },
    {
      language: "python",
      directories: [
        "src/gateway/api",
        "src/gateway/middleware",
        "src/saga/orchestrators",
        "src/saga/compensations",
        "src/services/order/api",
        "src/services/order/application",
        "src/services/order/domain",
        "src/services/order/infrastructure",
        "src/services/user/api",
        "src/services/user/application",
        "src/services/user/domain",
        "src/services/user/infrastructure",
        "src/shared/events",
        "src/shared/contracts",
      ],
      entryFiles: [
        { path: "src/gateway/api/gateway.py", purpose: "API Gateway 入口（FastAPI），统一路由、鉴权、限流" },
        { path: "src/saga/orchestrators/order_saga.py", purpose: "订单 Saga 编排器，协调跨服务事务" },
        { path: "src/saga/compensations/compensation_action.py", purpose: "补偿动作实现" },
        { path: "src/services/order/api/handler.py", purpose: "订单服务 API 处理器" },
        { path: "src/services/order/domain/aggregate.py", purpose: "订单服务聚合根" },
        { path: "src/shared/events/event_bus.py", purpose: "事件总线抽象" },
      ],
      configFile: "pyproject.toml",
    },
    {
      language: "go",
      directories: [
        "internal/gateway/api",
        "internal/gateway/middleware",
        "internal/saga/orchestrators",
        "internal/saga/compensations",
        "internal/services/order/api",
        "internal/services/order/application",
        "internal/services/order/domain",
        "internal/services/order/infrastructure",
        "internal/services/user/api",
        "internal/services/user/application",
        "internal/services/user/domain",
        "internal/services/user/infrastructure",
        "internal/shared/events",
        "internal/shared/contracts",
      ],
      entryFiles: [
        { path: "internal/gateway/api/gateway.go", purpose: "API Gateway 入口（gin/mux），统一路由、鉴权、限流" },
        { path: "internal/saga/orchestrators/order_saga.go", purpose: "订单 Saga 编排器，协调跨服务事务" },
        { path: "internal/saga/compensations/compensation_action.go", purpose: "补偿动作实现" },
        { path: "internal/services/order/api/handler.go", purpose: "订单服务 API 处理器" },
        { path: "internal/services/order/domain/aggregate.go", purpose: "订单服务聚合根" },
        { path: "internal/shared/events/event_bus.go", purpose: "事件总线抽象" },
      ],
      configFile: "go.mod",
    },
  ],

  // 依赖规则：服务间不得直接 import，必须通过 API/事件
  dependencyRules: [
    {
      id: "DEP-SVC-DIR-01",
      description:
        "服务间不得直接 import 对方代码——订单服务不得 import 用户服务的内部代码。" +
        "服务边界是限界上下文边界，跨服务直接引用代码将破坏服务独立性，" +
        "导致部署耦合、技术栈耦合、版本耦合。必须通过 API（HTTP/gRPC）或事件总线通信。",
      fromLayer: "services.order",
      forbiddenToLayers: ["services.user", "services.inventory"],
      severity: "blocker",
    },
    {
      id: "DEP-SVC-DB-01",
      description:
        "服务间不得共享数据库——每服务必须独立数据库或独立 schema。" +
        "数据库共享是微服务最严重的反模式：导致服务通过数据库耦合，破坏服务独立性，" +
        "数据库 schema 变更将波及多个服务。跨服务数据访问必须通过 API。",
      fromLayer: "services.order.infrastructure",
      forbiddenToLayers: ["services.user.infrastructure.database"],
      severity: "blocker",
    },
    {
      id: "DEP-GW-SVC-01",
      description:
        "API Gateway 不得包含业务逻辑——Gateway 仅负责路由、鉴权、限流、聚合。" +
        "在 Gateway 中写业务逻辑将导致 Gateway 成为分布式单体，违反微服务核心原则。" +
        "业务逻辑应内聚到对应服务中。",
      fromLayer: "gateway",
      forbiddenToLayers: ["services.**.domain", "services.**.application"],
      severity: "major",
    },
    {
      id: "DEP-SAGA-01",
      description:
        "Saga 编排器不得直接访问服务内部领域模型——Saga 通过 API 调用服务，" +
        "不直接 import 服务的聚合根或仓储。直接访问将导致 Saga 与服务实现耦合，" +
        "无法独立演进与替换。",
      fromLayer: "saga",
      forbiddenToLayers: ["services.**.domain", "services.**.infrastructure"],
      severity: "blocker",
    },
    {
      id: "DEP-SHARED-01",
      description:
        "shared 模块不得包含业务逻辑——shared 仅放置跨服务共享的契约定义（事件 schema、" +
        "API DTO）与通用工具。在 shared 中放业务逻辑将导致所有服务耦合到 shared，" +
        "形成分布式单体。shared 应保持极薄。",
      fromLayer: "shared",
      forbiddenToLayers: ["services.**.domain", "services.**.application"],
      severity: "warning",
    },
  ],

  // 命名规范：服务 XxxService、Saga XxxSaga
  namingConventions: [
    {
      element: "application-service",
      pattern: "XxxService",
      description:
        "服务名以 Service 后缀结尾（如 OrderService、UserService），标识一个微服务单元。" +
        "服务名应对应限界上下文名称，避免按技术分层命名（如避免 OrderDataService）。",
    },
    {
      element: "aggregate-root",
      pattern: "XxxAggregate",
      description:
        "聚合根类名以 Aggregate 后缀结尾（如 OrderAggregate），标识服务内的聚合边界。" +
        "微服务内每个聚合对应一个限界上下文的子域。",
    },
    {
      element: "domain-event",
      pattern: "XxxEvent",
      description:
        "领域事件类名以 Event 后缀结尾（如 OrderCreatedEvent、UserRegisteredEvent），" +
        "事件通过事件总线跨服务传递，是服务间异步通信的核心载体。",
    },
    {
      element: "application-service",
      pattern: "XxxSaga 或 XxxOrchestrator",
      description:
        "Saga 编排器类名以 Saga 或 Orchestrator 后缀结尾（如 OrderSaga、OrderOrchestrator），" +
        "标识跨服务事务的编排逻辑，包含正向步骤与补偿步骤。",
    },
    {
      element: "factory",
      pattern: "XxxCompensationAction 或 XxxCompensation",
      description:
        "补偿动作类名以 CompensationAction 或 Compensation 后缀结尾（如 RefundPaymentCompensationAction），" +
        "标识 Saga 失败时的回滚动作，必须幂等可重试。",
    },
    {
      element: "repository",
      pattern: "XxxRepository",
      description:
        "仓储接口名以 Repository 后缀结尾（如 OrderRepository），定义在服务内 domain 层；" +
        "实现类以 RepositoryImpl 后缀结尾，定义在服务内 infrastructure 层。每服务独立仓储。",
    },
    {
      element: "value-object",
      pattern: "XxxValueObject 或 XxxVO",
      description:
        "值对象类名以 ValueObject 或 VO 后缀结尾（如 MoneyVO、AddressVO），" +
        "在 shared/contracts 中定义跨服务共享的值对象契约。",
    },
  ],

  // 反模式清单：服务间数据库共享、Saga 缺补偿
  antiPatterns: [
    {
      id: "AP-SHARED-DB-01",
      name: "shared-database-microservice",
      description:
        "服务间共享数据库——多个微服务访问同一数据库实例与 schema。" +
        "微服务最严重的反模式：破坏服务独立性（schema 变更波及多服务）、" +
        "技术栈耦合（无法独立选择 ORM）、数据耦合（一个服务误操作影响其他服务）。" +
        "必须每服务独立数据库，跨服务数据通过 API。",
      detection: "static",
      severity: "blocker",
    },
    {
      id: "AP-SAGA-NO-COMP-01",
      name: "saga-missing-compensation",
      description:
        "Saga 缺少补偿动作——Saga 编排器定义了正向步骤但未定义对应的补偿步骤。" +
        "Saga 失败时无法回滚已执行步骤，将导致数据不一致（如扣了库存但订单未创建）。" +
        "每个正向步骤必须有对应的补偿动作，且补偿动作必须幂等可重试。",
      detection: "reasoning",
      severity: "blocker",
    },
    {
      id: "AP-SAGA-NO-IDEMP-01",
      name: "saga-step-missing-idempotency",
      description:
        "Saga 步骤缺失幂等性——Saga 步骤未做幂等控制，重试时可能产生重复操作" +
        "（如重复扣款）。每个 Saga 步骤必须支持幂等键（Idempotency-Key）或天然幂等语义，" +
        "确保重试安全。违反将导致业务故障（重复扣款/重复下单）。",
      detection: "reasoning",
      severity: "blocker",
    },
    {
      id: "AP-GW-LOGIC-01",
      name: "gateway-contains-business-logic",
      description:
        "Gateway 包含业务逻辑——在 API Gateway 中写业务规则、领域逻辑或数据聚合。" +
        "Gateway 退化为分布式单体，违反微服务核心原则。业务逻辑应内聚到对应服务，" +
        "Gateway 仅做路由、鉴权、限流、协议转换。",
      detection: "reasoning",
      severity: "major",
    },
    {
      id: "AP-DIST-MON-01",
      name: "distributed-monolith",
      description:
        "分布式单体——服务虽然独立部署，但通过同步调用链强耦合" +
        "（如订单服务必须同步等待用户、库存、支付服务响应）。" +
        "任一服务故障将导致整个调用链失败。应优先采用异步事件通信，" +
        "同步调用必须有超时、熔断、降级策略。",
      detection: "reasoning",
      severity: "warning",
    },
    {
      id: "AP-SVC-NO-BC-01",
      name: "service-without-bounded-context",
      description:
        "服务未对应限界上下文——按技术分层（如 AuthService、LoggingService）" +
        "而非业务边界划分服务。违反微服务按业务能力划分的原则，导致服务边界模糊、" +
        "业务逻辑分散。应按业务子域划分（如 OrderService、UserService）。",
      detection: "reasoning",
      severity: "major",
    },
  ],
} satisfies ArchitectureParadigm;

/**
 * 微服务架构范式定义（冻结导出）
 *
 * 内部 _MICROSERVICE_PARADIGM 已通过 `satisfies ArchitectureParadigm` 完整类型校验，
 * Object.freeze 冻结后对外导出，确保运行期不可被 LLM 自改。
 */
export const MICROSERVICE_PARADIGM: ArchitectureParadigm = Object.freeze(_MICROSERVICE_PARADIGM);
