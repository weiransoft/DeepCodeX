/**
 * 范式定义：DDD 分层架构（Domain-Driven Design Layered Architecture）
 *
 * 本模块定义 EAG 方案 §5.1.1 首版 4 范式之一的 DDD 分层架构。
 *
 * 范式核心：
 * - 四层结构：interfaces（接口层）/ application（应用层）/ domain（领域层）/ infrastructure（基础设施层）
 * - 依赖方向：外层依赖内层，domain 层零外部依赖（不依赖 infrastructure/application/interfaces）
 * - 战术构件：聚合根（Aggregate Root）/ 实体（Entity）/ 值对象（Value Object）/ 领域事件（Domain Event）/ 仓储（Repository）/ 工厂（Factory）
 * - 适用场景：业务复杂、强一致、单体或少量集成
 *
 * 设计依据：
 * - EAG 方案 §5.1.1 范式库表格 ddd-layered 行
 * - Evans《Domain-Driven Design》四层架构
 * - Vernon《Implementing Domain-Driven Design》分层架构
 *
 * 不可变保证：
 * - 所有字段 readonly
 * - 顶层常量 Object.freeze 冻结，防止运行期被 LLM 自改
 * - 对齐 §5.12.4 G-A6d 配置冻结原则
 *
 * @module eag/eak/paradigms/ddd-layered
 */

import type { ArchitectureParadigm } from "../types";

/**
 * DDD 分层架构范式定义常量
 *
 * 使用 Object.freeze 冻结，作为评估器判定与骨架生成器的输入数据。
 * 修改本常量需走架构变更评审流程。
 *
 * 实现说明：先以字面量对象 + `satisfies ArchitectureParadigm` 做完整类型校验
 * 并保留字面量类型（避免 TS widen 为 string），再 Object.freeze 冻结。
 */
const _DDD_LAYERED_PARADIGM = {
  id: "ddd-layered",
  name: "DDD 分层架构",
  description:
    "领域驱动设计四层架构（interfaces/application/domain/infrastructure），" +
    "以领域模型为核心，外层依赖内层。domain 层零外部依赖，承载聚合根/实体/值对象/" +
    "领域事件等战术构件。适用于业务复杂、强一致、单体或少量集成的场景。",

  // 适用信号：业务复杂度高、强一致、读写均衡或写密集、单体或少量集成
  applicabilitySignals: {
    domainComplexity: "high",
    consistencyRequirement: "strong",
    readWritePattern: "balanced",
    integrationComplexity: "monolith",
  },

  // 信号证据：本字段在自主选择时由架构师动态填充，引用需求原文。
  // 范式定义本身不携带证据（避免与具体需求耦合），仅作为打分时的参考信号。
  // 评估器在 DESIGN Loop 验证阶段会要求架构师填充 signalEvidence，缺失即打回。

  // 多语言骨架模板：TypeScript/Java/Python/Go 四语言
  skeletonTemplates: [
    {
      language: "typescript",
      // 由外到内排列：interfaces → application → domain → infrastructure
      directories: [
        "src/interfaces/api",
        "src/interfaces/cli",
        "src/application/services",
        "src/application/dto",
        "src/domain/aggregates",
        "src/domain/entities",
        "src/domain/value-objects",
        "src/domain/events",
        "src/domain/repositories",
        "src/infrastructure/persistence",
        "src/infrastructure/messaging",
        "src/infrastructure/config",
      ],
      entryFiles: [
        { path: "src/interfaces/api/routes.ts", purpose: "API 路由入口，仅做请求/响应转换，不含业务逻辑" },
        {
          path: "src/application/services/application-service.ts",
          purpose: "应用服务，编排领域对象、事务边界、事件发布",
        },
        { path: "src/domain/aggregates/aggregate-root.ts", purpose: "聚合根基类，封装聚合内一致性不变式" },
        {
          path: "src/domain/repositories/repository.interface.ts",
          purpose: "仓储接口（依赖反转），由 infrastructure 实现",
        },
        { path: "src/infrastructure/persistence/repository.impl.ts", purpose: "仓储实现，封装 ORM/数据库访问" },
      ],
      configFile: "tsconfig.json",
    },
    {
      language: "java",
      directories: [
        "src/main/java/com/example/interfaces/api",
        "src/main/java/com/example/interfaces/cli",
        "src/main/java/com/example/application/services",
        "src/main/java/com/example/application/dto",
        "src/main/java/com/example/domain/aggregates",
        "src/main/java/com/example/domain/entities",
        "src/main/java/com/example/domain/valueobjects",
        "src/main/java/com/example/domain/events",
        "src/main/java/com/example/domain/repositories",
        "src/main/java/com/example/infrastructure/persistence",
        "src/main/java/com/example/infrastructure/messaging",
        "src/main/java/com/example/infrastructure/config",
      ],
      entryFiles: [
        {
          path: "src/main/java/com/example/interfaces/api/Controller.java",
          purpose: "REST 控制器，仅做请求/响应转换与 DTO 校验",
        },
        {
          path: "src/main/java/com/example/application/services/ApplicationService.java",
          purpose: "应用服务，编排领域对象、事务边界、事件发布",
        },
        {
          path: "src/main/java/com/example/domain/aggregates/AggregateRoot.java",
          purpose: "聚合根基类，封装聚合内一致性不变式",
        },
        {
          path: "src/main/java/com/example/domain/repositories/Repository.java",
          purpose: "仓储接口（依赖反转），由 infrastructure 实现",
        },
        {
          path: "src/main/java/com/example/infrastructure/persistence/RepositoryImpl.java",
          purpose: "仓储实现，封装 JPA/MyBatis 访问",
        },
      ],
      configFile: "pom.xml",
    },
    {
      language: "python",
      directories: [
        "src/interfaces/api",
        "src/interfaces/cli",
        "src/application/services",
        "src/application/dto",
        "src/domain/aggregates",
        "src/domain/entities",
        "src/domain/value_objects",
        "src/domain/events",
        "src/domain/repositories",
        "src/infrastructure/persistence",
        "src/infrastructure/messaging",
        "src/infrastructure/config",
      ],
      entryFiles: [
        { path: "src/interfaces/api/routes.py", purpose: "API 路由入口，仅做请求/响应转换，不含业务逻辑" },
        {
          path: "src/application/services/application_service.py",
          purpose: "应用服务，编排领域对象、事务边界、事件发布",
        },
        { path: "src/domain/aggregates/aggregate_root.py", purpose: "聚合根基类，封装聚合内一致性不变式" },
        { path: "src/domain/repositories/repository.py", purpose: "仓储抽象基类（依赖反转），由 infrastructure 实现" },
        { path: "src/infrastructure/persistence/repository_impl.py", purpose: "仓储实现，封装 SQLAlchemy 访问" },
      ],
      configFile: "pyproject.toml",
    },
    {
      language: "go",
      directories: [
        "internal/interfaces/api",
        "internal/interfaces/cli",
        "internal/application/services",
        "internal/application/dto",
        "internal/domain/aggregates",
        "internal/domain/entities",
        "internal/domain/valueobjects",
        "internal/domain/events",
        "internal/domain/repositories",
        "internal/infrastructure/persistence",
        "internal/infrastructure/messaging",
        "internal/infrastructure/config",
      ],
      entryFiles: [
        { path: "internal/interfaces/api/handler.go", purpose: "API 处理器，仅做请求/响应转换，不含业务逻辑" },
        { path: "internal/application/services/service.go", purpose: "应用服务，编排领域对象、事务边界、事件发布" },
        { path: "internal/domain/aggregates/aggregate_root.go", purpose: "聚合根基类，封装聚合内一致性不变式" },
        { path: "internal/domain/repositories/repository.go", purpose: "仓储接口（依赖反转），由 infrastructure 实现" },
        {
          path: "internal/infrastructure/persistence/repository_impl.go",
          purpose: "仓储实现，封装 GORM/database/sql 访问",
        },
      ],
      configFile: "go.mod",
    },
  ],

  // 依赖规则：domain 层零外部依赖；application 不得依赖 interfaces；infrastructure 不得被 domain 依赖
  dependencyRules: [
    {
      id: "DEP-DOM-01",
      description:
        "领域层（domain）不得 import 基础设施层（infrastructure）。" +
        "domain 层是业务核心，依赖 infrastructure 将导致领域层被 ORM/消息队列等绑架，" +
        "无法独立测试与演进，违反依赖反转原则。",
      fromLayer: "domain",
      forbiddenToLayers: ["infrastructure"],
      severity: "blocker",
    },
    {
      id: "DEP-DOM-02",
      description:
        "领域层（domain）不得 import 应用层（application）。" +
        "application 是 domain 的消费者，反向依赖将形成循环，破坏分层架构的核心约束。",
      fromLayer: "domain",
      forbiddenToLayers: ["application"],
      severity: "blocker",
    },
    {
      id: "DEP-DOM-03",
      description:
        "领域层（domain）不得 import 接口层（interfaces）。" +
        "interfaces 是最外层，依赖它将使 domain 被具体传输协议（HTTP/gRPC）绑架，" +
        "无法支持多通道接入。",
      fromLayer: "domain",
      forbiddenToLayers: ["interfaces"],
      severity: "blocker",
    },
    {
      id: "DEP-APP-01",
      description:
        "应用层（application）不得 import 接口层（interfaces）。" +
        "application 是业务编排层，应保持传输协议无关，依赖 interfaces 将导致接口变更波及应用层。",
      fromLayer: "application",
      forbiddenToLayers: ["interfaces"],
      severity: "major",
    },
    {
      id: "DEP-INFRA-01",
      description:
        "基础设施层（infrastructure）不得被接口层（interfaces）直接引用。" +
        "infrastructure 应通过 application 间接调用，interfaces 直接依赖 infrastructure 将绕过应用编排与事务边界。",
      fromLayer: "interfaces",
      forbiddenToLayers: ["infrastructure"],
      severity: "major",
    },
  ],

  // 命名规范：聚合根 XxxAggregate、领域事件 XxxEvent、仓储 XxxRepository 等
  namingConventions: [
    {
      element: "aggregate-root",
      pattern: "XxxAggregate",
      description:
        "聚合根类名必须以 Aggregate 后缀结尾（如 OrderAggregate、UserAggregate），" +
        "便于在代码库中识别聚合边界，对齐 DDD 战术设计约定。",
    },
    {
      element: "entity",
      pattern: "XxxEntity",
      description:
        "实体类名必须以 Entity 后缀结尾（如 OrderLineEntity），区分聚合根与聚合内实体，" + "避免与值对象混淆。",
    },
    {
      element: "value-object",
      pattern: "XxxValueObject 或 XxxVO",
      description:
        "值对象类名以 ValueObject 或 VO 后缀结尾（如 AddressValueObject、MoneyVO），" +
        "标识无唯一标识的不可变对象，对齐 DDD 值对象语义。",
    },
    {
      element: "domain-event",
      pattern: "XxxEvent",
      description:
        "领域事件类名以 Event 后缀结尾（如 OrderCreatedEvent、UserRegisteredEvent），" +
        "采用过去式动词描述已发生的业务事实，便于事件溯源与投影重建。",
    },
    {
      element: "application-service",
      pattern: "XxxApplicationService 或 XxxAppService",
      description:
        "应用服务类名以 ApplicationService 或 AppService 后缀结尾（如 OrderApplicationService），" +
        "区分领域服务（Domain Service）与基础设施服务（Infrastructure Service）。",
    },
    {
      element: "repository",
      pattern: "XxxRepository",
      description:
        "仓储接口名以 Repository 后缀结尾（如 OrderRepository），定义在 domain 层；" +
        "实现类以 RepositoryImpl 后缀结尾（如 OrderRepositoryImpl），定义在 infrastructure 层。",
    },
    {
      element: "factory",
      pattern: "XxxFactory",
      description:
        "工厂类名以 Factory 后缀结尾（如 OrderFactory），封装复杂聚合的构造逻辑与不变式校验，" +
        "避免直接 new 导致不变式被绕过。",
    },
  ],

  // 反模式清单：贫血模型、跨聚合直接引用、Domain 依赖 ORM 等
  antiPatterns: [
    {
      id: "AP-ANEMIC-01",
      name: "anemic-domain-model",
      description:
        "贫血模型——实体类仅有 getter/setter 无业务方法，业务逻辑散落在 Service 层。" +
        "违反 DDD 将数据与行为内聚的核心原则，导致领域层退化为 DTO 层、测试困难、" +
        "业务规则被多处复制粘贴。注意：值对象天然无业务方法，本反模式不适用于值对象。",
      detection: "reasoning",
      severity: "warning",
    },
    {
      id: "AP-CROSS-AGG-01",
      name: "cross-aggregate-reference",
      description:
        "跨聚合直接引用——聚合根 A 持有聚合根 B 的引用并直接调用其方法。" +
        "违反聚合边界一致性原则：聚合间应通过 ID 引用 + 仓储加载，而非对象引用直接调用。" +
        "直接引用将导致聚合边界形同虚设、事务边界扩大、性能问题（懒加载 N+1）。",
      detection: "reasoning",
      severity: "major",
    },
    {
      id: "AP-DOM-ORM-01",
      name: "domain-depends-on-orm",
      description:
        "领域层依赖 ORM 框架——domain 层的实体/聚合根直接使用 ORM 装饰器（如 @Entity/@Table）" +
        "或继承 ORM 基类。违反 domain 层零外部依赖原则，导致领域模型被持久化框架绑架，" +
        "无法切换 ORM 或独立测试。应通过基础设施层的映射器（Mapper）转换 domain 模型与持久化模型。",
      detection: "static",
      severity: "blocker",
    },
    {
      id: "AP-TRANS-LOGIC-01",
      name: "transaction-script-in-service",
      description:
        "服务层的事务脚本模式——Application Service 直接写业务逻辑而非编排领域对象。" +
        "Service 方法变成超长的事务脚本，领域逻辑未内聚到实体/聚合根。" +
        "这是贫血模型的伴生反模式，违反 DDD 的核心动机（将业务逻辑回归领域层）。",
      detection: "reasoning",
      severity: "major",
    },
    {
      id: "AP-REPO-DOM-01",
      name: "repository-in-application-layer",
      description:
        "仓储定义在应用层而非领域层——将 Repository 接口放在 application 包下。" +
        "违反依赖反转原则：仓储接口是领域层定义的契约，由基础设施层实现。" +
        "放在应用层将导致领域层失去对持久化的抽象能力，被应用层绑架。",
      detection: "static",
      severity: "major",
    },
  ],
} satisfies ArchitectureParadigm;

/**
 * DDD 分层架构范式定义（冻结导出）
 *
 * 内部 _DDD_LAYERED_PARADIGM 已通过 `satisfies ArchitectureParadigm` 完整类型校验，
 * Object.freeze 冻结后对外导出，确保运行期不可被 LLM 自改。
 */
export const DDD_LAYERED_PARADIGM: ArchitectureParadigm = Object.freeze(_DDD_LAYERED_PARADIGM);
