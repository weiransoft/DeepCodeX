/**
 * 范式定义：Clean Architecture（整洁架构）
 *
 * 本模块定义 EAG 方案 §5.1.1 首版 4 范式之一的 Clean Architecture。
 *
 * 范式核心：
 * - 四层同心圆：entities（实体）/ use-cases（用例）/ adapters（适配器）/ frameworks（框架）
 * - 依赖方向：依赖仅指向内层（外层依赖内层，内层不得依赖外层）
 * - 战术构件：实体（Entity）/ 用例（UseCase）/ 接口适配器（Adapter）/ 框架与驱动（Framework）
 * - 适用场景：业务中等、重视可测试性、可替换性高
 *
 * 设计依据：
 * - EAG 方案 §5.1.1 范式库表格 clean-architecture 行
 * - Martin《Clean Architecture》同心圆架构
 *
 * 与 DDD 分层架构的差异：
 * - Clean Architecture 强调"依赖反转"而非"领域分层"
 * - 实体层是纯业务对象，无持久化考虑
 * - 用例层编排业务流程，对应 DDD 的应用层
 * - 适配器层负责格式转换与协议适配
 * - 框架层是最外圈，包括 Web 框架、数据库、外部 API
 *
 * 不可变保证：
 * - 所有字段 readonly
 * - 顶层常量 Object.freeze 冻结，防止运行期被 LLM 自改
 * - 对齐 §5.12.4 G-A6d 配置冻结原则
 *
 * @module eag/eak/paradigms/clean-architecture
 */

import type { ArchitectureParadigm } from "../types";

/**
 * Clean Architecture 范式定义常量
 *
 * 使用 Object.freeze 冻结，作为评估器判定与骨架生成器的输入数据。
 * 修改本常量需走架构变更评审流程。
 *
 * 实现说明：先以字面量对象 + `satisfies ArchitectureParadigm` 做完整类型校验
 * 并保留字面量类型（避免 TS widen 为 string），再 Object.freeze 冻结。
 */
const _CLEAN_ARCHITECTURE_PARADIGM = {
  id: "clean-architecture",
  name: "Clean Architecture",
  description:
    "Robert C. Martin 提出的同心圆架构，四层从内到外为 entities（实体）/" +
    "use-cases（用例）/ adapters（适配器）/ frameworks（框架）。依赖方向严格指向内层——" +
    "外层依赖内层，内层不得依赖外层。适用于业务中等、重视可测试性与可替换性的场景。",

  // 适用信号：业务复杂度中、强一致或最终一致均可、读写均衡、单体或少量集成
  applicabilitySignals: {
    domainComplexity: "medium",
    consistencyRequirement: "strong",
    readWritePattern: "balanced",
    integrationComplexity: "few-integrations",
  },

  // 多语言骨架模板：TypeScript/Java/Python/Go 四语言
  skeletonTemplates: [
    {
      language: "typescript",
      // 由外到内排列：frameworks → adapters → use-cases → entities
      directories: [
        "src/frameworks/web",
        "src/frameworks/database",
        "src/frameworks/external",
        "src/adapters/controllers",
        "src/adapters/presenters",
        "src/adapters/gateways",
        "src/use-cases/contracts",
        "src/use-cases/interactors",
        "src/entities",
      ],
      entryFiles: [
        { path: "src/frameworks/web/server.ts", purpose: "Web 服务器启动入口（Express/Fastify），最外圈框架层" },
        { path: "src/adapters/controllers/controller.ts", purpose: "控制器，将 HTTP 请求转换为用例输入" },
        { path: "src/adapters/gateways/repository-gateway.ts", purpose: "仓储网关实现，实现用例层定义的接口" },
        { path: "src/use-cases/interactors/use-case.ts", purpose: "用例交互器，编排业务流程，依赖实体与接口契约" },
        { path: "src/use-cases/contracts/repository.ts", purpose: "仓储接口契约（依赖反转），由 adapters 实现" },
        { path: "src/entities/entity.ts", purpose: "业务实体，最内层纯业务对象，零外部依赖" },
      ],
      configFile: "tsconfig.json",
    },
    {
      language: "java",
      directories: [
        "src/main/java/com/example/frameworks/web",
        "src/main/java/com/example/frameworks/database",
        "src/main/java/com/example/frameworks/external",
        "src/main/java/com/example/adapters/controllers",
        "src/main/java/com/example/adapters/presenters",
        "src/main/java/com/example/adapters/gateways",
        "src/main/java/com/example/usecases/contracts",
        "src/main/java/com/example/usecases/interactors",
        "src/main/java/com/example/entities",
      ],
      entryFiles: [
        {
          path: "src/main/java/com/example/frameworks/web/SpringBootApp.java",
          purpose: "Spring Boot 启动类，最外圈框架层",
        },
        {
          path: "src/main/java/com/example/adapters/controllers/Controller.java",
          purpose: "控制器，将 HTTP 请求转换为用例输入",
        },
        {
          path: "src/main/java/com/example/adapters/gateways/RepositoryGateway.java",
          purpose: "仓储网关实现，实现用例层定义的接口",
        },
        { path: "src/main/java/com/example/usecases/interactors/UseCase.java", purpose: "用例交互器，编排业务流程" },
        { path: "src/main/java/com/example/usecases/contracts/Repository.java", purpose: "仓储接口契约（依赖反转）" },
        { path: "src/main/java/com/example/entities/Entity.java", purpose: "业务实体，最内层纯业务对象" },
      ],
      configFile: "pom.xml",
    },
    {
      language: "python",
      directories: [
        "src/frameworks/web",
        "src/frameworks/database",
        "src/frameworks/external",
        "src/adapters/controllers",
        "src/adapters/presenters",
        "src/adapters/gateways",
        "src/use_cases/contracts",
        "src/use_cases/interactors",
        "src/entities",
      ],
      entryFiles: [
        { path: "src/frameworks/web/server.py", purpose: "Web 服务器启动入口（FastAPI/Flask），最外圈框架层" },
        { path: "src/adapters/controllers/controller.py", purpose: "控制器，将 HTTP 请求转换为用例输入" },
        { path: "src/adapters/gateways/repository_gateway.py", purpose: "仓储网关实现，实现用例层定义的接口" },
        { path: "src/use_cases/interactors/use_case.py", purpose: "用例交互器，编排业务流程" },
        { path: "src/use_cases/contracts/repository.py", purpose: "仓储接口契约（依赖反转），ABC 基类" },
        { path: "src/entities/entity.py", purpose: "业务实体，最内层纯业务对象" },
      ],
      configFile: "pyproject.toml",
    },
    {
      language: "go",
      directories: [
        "internal/frameworks/web",
        "internal/frameworks/database",
        "internal/frameworks/external",
        "internal/adapters/controllers",
        "internal/adapters/presenters",
        "internal/adapters/gateways",
        "internal/usecases/contracts",
        "internal/usecases/interactors",
        "internal/entities",
      ],
      entryFiles: [
        { path: "internal/frameworks/web/server.go", purpose: "Web 服务器启动入口（gin/echo），最外圈框架层" },
        { path: "internal/adapters/controllers/controller.go", purpose: "控制器，将 HTTP 请求转换为用例输入" },
        { path: "internal/adapters/gateways/repository_gateway.go", purpose: "仓储网关实现，实现用例层定义的接口" },
        { path: "internal/usecases/interactors/use_case.go", purpose: "用例交互器，编排业务流程" },
        { path: "internal/usecases/contracts/repository.go", purpose: "仓储接口契约（依赖反转），Go interface" },
        { path: "internal/entities/entity.go", purpose: "业务实体，最内层纯业务对象" },
      ],
      configFile: "go.mod",
    },
  ],

  // 依赖规则：外层不得被内层依赖
  dependencyRules: [
    {
      id: "DEP-ENT-01",
      description:
        "实体层（entities）不得依赖用例层（use-cases）。" +
        "entities 是最内层纯业务对象，依赖 use-cases 将形成循环依赖，" +
        "破坏同心圆架构的核心约束。entities 应保持零外部依赖。",
      fromLayer: "entities",
      forbiddenToLayers: ["use-cases", "adapters", "frameworks"],
      severity: "blocker",
    },
    {
      id: "DEP-UC-01",
      description:
        "用例层（use-cases）不得依赖适配器层（adapters）与框架层（frameworks）。" +
        "use-cases 是业务编排层，应通过 contracts 接口依赖外层实现（依赖反转），" +
        "直接依赖外层将导致用例被框架绑架，无法独立测试。",
      fromLayer: "use-cases",
      forbiddenToLayers: ["adapters", "frameworks"],
      severity: "blocker",
    },
    {
      id: "DEP-ADP-01",
      description:
        "适配器层（adapters）不得被框架层（frameworks）直接依赖实现细节。" +
        "frameworks 应通过 adapters 提供的接口调用，避免框架直接耦合适配器实现，" +
        "保证适配器可独立替换。",
      fromLayer: "frameworks",
      forbiddenToLayers: ["adapters"],
      severity: "major",
    },
    {
      id: "DEP-UC-02",
      description:
        "用例层（use-cases）只能通过 contracts 接口依赖外层，不得 import 具体实现类。" +
        "依赖反转的核心：use-cases 定义接口，adapters/frameworks 实现接口，" +
        "通过 DI 容器在运行期注入。直接 import 实现类将破坏可测试性。",
      fromLayer: "use-cases",
      forbiddenToLayers: ["adapters.impl", "frameworks.impl"],
      severity: "major",
    },
    {
      id: "DEP-ENT-02",
      description:
        "实体层（entities）不得引用任何外部库（除纯函数工具库）。" +
        "entities 是业务核心，引入外部库（如 ORM、序列化、校验库）将导致实体被绑架，" +
        "破坏可替换性原则。校验应在构造函数断言中实现而非依赖装饰器库。",
      fromLayer: "entities",
      forbiddenToLayers: ["external-libs"],
      severity: "warning",
    },
  ],

  // 命名规范：用例 XxxUseCase、实体 XxxEntity
  namingConventions: [
    {
      element: "entity",
      pattern: "XxxEntity",
      description:
        "实体类名以 Entity 后缀结尾（如 UserEntity、ProductEntity），" +
        "标识最内层纯业务对象，与适配器层的数据传输对象区分。",
    },
    {
      element: "application-service",
      pattern: "XxxUseCase 或 XxxInteractor",
      description:
        "用例类名以 UseCase 或 Interactor 后缀结尾（如 CreateUserUseCase、OrderInteractor），" +
        "标识业务用例的边界与单一职责，每个用例对应一个交互器类。",
    },
    {
      element: "repository",
      pattern: "XxxRepository / XxxGateway",
      description:
        "仓储接口名以 Repository 或 Gateway 后缀结尾（如 UserRepository、UserGateway），" +
        "定义在 use-cases/contracts；实现类以 Impl 或 GatewayImpl 后缀结尾，定义在 adapters/gateways。",
    },
    {
      element: "factory",
      pattern: "XxxFactory",
      description:
        "工厂类名以 Factory 后缀结尾（如 UserFactory），封装实体的构造逻辑与不变式校验，" +
        "避免直接 new 导致不变式被绕过。",
    },
    {
      element: "domain-event",
      pattern: "XxxEvent 或 XxxResponse",
      description:
        "用例输出事件以 Event 或 Response 后缀结尾（如 UserCreatedEvent、CreateUserResponse），" +
        "标识用例的输出契约，便于 presenter 转换为不同的传输格式。",
    },
    {
      element: "value-object",
      pattern: "XxxValueObject 或 XxxVO",
      description:
        "值对象类名以 ValueObject 或 VO 后缀结尾（如 EmailVO、MoneyValueObject），" +
        "标识不可变的值对象，对齐 Clean Architecture 实体层语义。",
    },
    {
      element: "aggregate-root",
      pattern: "XxxAggregate",
      description:
        "聚合根类名以 Aggregate 后缀结尾（如 OrderAggregate），标识聚合边界，" +
        "Clean Architecture 中聚合根属于 entities 层，封装一致性不变式。",
    },
  ],

  // 反模式清单：外层侵入内层、Entity 依赖框架
  antiPatterns: [
    {
      id: "AP-OUTER-INV-01",
      name: "outer-layer-invades-inner",
      description:
        "外层侵入内层——adapters/frameworks 的代码侵入 entities/use-cases 的实现。" +
        "如：在实体类中注入 framework 的 Logger、在 use-case 中调用 ORM Session。" +
        "违反依赖反转原则，导致内层被外层绑架，可测试性丧失。",
      detection: "reasoning",
      severity: "blocker",
    },
    {
      id: "AP-ENT-FRAMEWORK-01",
      name: "entity-depends-on-framework",
      description:
        "实体层依赖框架——entities 直接使用框架装饰器（如 @Entity、@Component）" +
        "或继承框架基类。违反 entities 零外部依赖原则，应通过 adapters 层的 mapper 转换" +
        "实体与持久化对象。",
      detection: "static",
      severity: "blocker",
    },
    {
      id: "AP-UC-DI-01",
      name: "use-case-directly-instantiates-repository",
      description:
        "用例直接实例化仓储实现——UseCase 内部 new RepositoryImpl() 而非通过构造函数注入。" +
        "违反依赖反转与单一职责，导致用例与具体实现耦合，无法替换为 Mock 进行单元测试。",
      detection: "static",
      severity: "major",
    },
    {
      id: "AP-FAT-UC-01",
      name: "fat-use-case",
      description:
        "肥胖用例——单个 UseCase 类承担过多职责（CRUD 全包），方法超过 5 个。" +
        "违反单一职责原则，应按业务用例拆分（CreateUserUseCase、UpdateUserUseCase 独立），" +
        "便于按用例组织测试与演进。",
      detection: "reasoning",
      severity: "warning",
    },
    {
      id: "AP-BYPASS-ADP-01",
      name: "framework-bypasses-adapter",
      description:
        "框架层绕过适配器层直接调用用例——frameworks 直接 import use-cases/interactors。" +
        "绕过 adapters/controllers 的请求转换，将导致输入校验、错误处理被跳过，" +
        "破坏分层架构的隔离性。",
      detection: "static",
      severity: "major",
    },
  ],
} satisfies ArchitectureParadigm;

/**
 * Clean Architecture 范式定义（冻结导出）
 *
 * 内部 _CLEAN_ARCHITECTURE_PARADIGM 已通过 `satisfies ArchitectureParadigm` 完整类型校验，
 * Object.freeze 冻结后对外导出，确保运行期不可被 LLM 自改。
 */
export const CLEAN_ARCHITECTURE_PARADIGM: ArchitectureParadigm = Object.freeze(_CLEAN_ARCHITECTURE_PARADIGM);
