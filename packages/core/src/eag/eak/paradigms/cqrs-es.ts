/**
 * 范式定义：CQRS + Event Sourcing（命令查询职责分离 + 事件溯源）
 *
 * 本模块定义 EAG 方案 §5.1.1 首版 4 范式之一的 CQRS + Event Sourcing。
 *
 * 范式核心：
 * - 命令侧（command-side）与查询侧（query-side）分离
 * - 写入通过命令（Command）触发，命令处理器（CommandHandler）执行业务逻辑并产生领域事件
 * - 事件溯源（Event Sourcing）将聚合状态变更持久化为事件流，重放事件重建状态
 * - 投影器（Projector）订阅事件流，构建并维护读模型（Read Model）
 * - 查询侧仅查询读模型，不走命令路径
 * - 适用场景：读写悬殊、审计要求高、最终一致可接受
 *
 * 设计依据：
 * - EAG 方案 §5.1.1 范式库表格 cqrs-es 行
 * - Young《CQRS Documents》、Fowler《Event Sourcing》
 *
 * 与 DDD/Clean Architecture 的差异：
 * - 读写模型分离——读模型可以是反范式化的视图，写模型是规范化的聚合
 * - 事件是不可变的事实记录，可作为审计依据
 * - 最终一致——读模型的状态滞后于写模型，需要投影器异步同步
 *
 * 不可变保证：
 * - 所有字段 readonly
 * - 顶层常量 Object.freeze 冻结
 * - 对齐 §5.12.4 G-A6d 配置冻结原则
 *
 * @module eag/eak/paradigms/cqrs-es
 */

import type { ArchitectureParadigm } from "../types";

/**
 * CQRS + Event Sourcing 范式定义常量
 *
 * 使用 Object.freeze 冻结，作为评估器判定与骨架生成器的输入数据。
 * 修改本常量需走架构变更评审流程。
 *
 * 实现说明：先以字面量对象 + `satisfies ArchitectureParadigm` 做完整类型校验
 * 并保留字面量类型（避免 TS widen 为 string），再 Object.freeze 冻结。
 */
const _CQRS_ES_PARADIGM = {
  id: "cqrs-es",
  name: "CQRS + Event Sourcing",
  description:
    "命令查询职责分离 + 事件溯源架构。命令侧（command-side）处理写操作并产生领域事件，" +
    "查询侧（query-side）通过投影器（Projector）订阅事件流构建读模型（Read Model）。" +
    "聚合状态以事件流形式持久化，重放事件重建状态。适用于读写悬殊、审计要求高、" +
    "最终一致可接受的场景。",

  // 适用信号：业务复杂度高、最终一致可接受、读远多于写、多系统集成
  applicabilitySignals: {
    domainComplexity: "high",
    consistencyRequirement: "eventual",
    readWritePattern: "read-heavy",
    integrationComplexity: "many-systems",
  },

  // 多语言骨架模板：TypeScript/Java/Python/Go 四语言
  skeletonTemplates: [
    {
      language: "typescript",
      // 命令侧与查询侧分离
      directories: [
        "src/command/api",
        "src/command/application/handlers",
        "src/command/domain/aggregates",
        "src/command/domain/commands",
        "src/command/domain/events",
        "src/command/infrastructure/event-store",
        "src/query/api",
        "src/query/application/queries",
        "src/query/application/projections",
        "src/query/infrastructure/read-model",
        "src/shared/events",
      ],
      entryFiles: [
        { path: "src/command/api/routes.ts", purpose: "命令侧 API 路由入口，仅接收写请求" },
        {
          path: "src/command/application/handlers/command-handler.ts",
          purpose: "命令处理器，编排聚合根执行业务逻辑并产生事件",
        },
        {
          path: "src/command/domain/aggregates/aggregate-root.ts",
          purpose: "聚合根基类，封装状态转换方法 + 事件应用方法",
        },
        {
          path: "src/command/infrastructure/event-store/event-store.ts",
          purpose: "事件存储实现，持久化事件流（PostgreSQL/EventStoreDB）",
        },
        { path: "src/query/api/routes.ts", purpose: "查询侧 API 路由入口，仅接收读请求" },
        { path: "src/query/application/projections/projector.ts", purpose: "投影器，订阅事件流并更新读模型" },
        { path: "src/query/infrastructure/read-model/repository.ts", purpose: "读模型仓储，查询反范式化的视图" },
      ],
      configFile: "tsconfig.json",
    },
    {
      language: "java",
      directories: [
        "src/main/java/com/example/command/api",
        "src/main/java/com/example/command/application/handlers",
        "src/main/java/com/example/command/domain/aggregates",
        "src/main/java/com/example/command/domain/commands",
        "src/main/java/com/example/command/domain/events",
        "src/main/java/com/example/command/infrastructure/eventstore",
        "src/main/java/com/example/query/api",
        "src/main/java/com/example/query/application/queries",
        "src/main/java/com/example/query/application/projections",
        "src/main/java/com/example/query/infrastructure/readmodel",
        "src/main/java/com/example/shared/events",
      ],
      entryFiles: [
        {
          path: "src/main/java/com/example/command/api/CommandController.java",
          purpose: "命令侧 REST 控制器，仅接收写请求",
        },
        {
          path: "src/main/java/com/example/command/application/handlers/CommandHandler.java",
          purpose: "命令处理器，编排聚合根执行业务逻辑并产生事件",
        },
        {
          path: "src/main/java/com/example/command/domain/aggregates/AggregateRoot.java",
          purpose: "聚合根基类，封装状态转换方法 + 事件应用方法",
        },
        {
          path: "src/main/java/com/example/command/infrastructure/eventstore/EventStore.java",
          purpose: "事件存储实现，持久化事件流",
        },
        {
          path: "src/main/java/com/example/query/api/QueryController.java",
          purpose: "查询侧 REST 控制器，仅接收读请求",
        },
        {
          path: "src/main/java/com/example/query/application/projections/Projector.java",
          purpose: "投影器，订阅事件流并更新读模型",
        },
        {
          path: "src/main/java/com/example/query/infrastructure/readmodel/ReadModelRepository.java",
          purpose: "读模型仓储",
        },
      ],
      configFile: "pom.xml",
    },
    {
      language: "python",
      directories: [
        "src/command/api",
        "src/command/application/handlers",
        "src/command/domain/aggregates",
        "src/command/domain/commands",
        "src/command/domain/events",
        "src/command/infrastructure/event_store",
        "src/query/api",
        "src/query/application/queries",
        "src/query/application/projections",
        "src/query/infrastructure/read_model",
        "src/shared/events",
      ],
      entryFiles: [
        { path: "src/command/api/routes.py", purpose: "命令侧 API 路由入口，仅接收写请求" },
        {
          path: "src/command/application/handlers/command_handler.py",
          purpose: "命令处理器，编排聚合根执行业务逻辑并产生事件",
        },
        {
          path: "src/command/domain/aggregates/aggregate_root.py",
          purpose: "聚合根基类，封装状态转换方法 + 事件应用方法",
        },
        { path: "src/command/infrastructure/event_store/event_store.py", purpose: "事件存储实现，持久化事件流" },
        { path: "src/query/api/routes.py", purpose: "查询侧 API 路由入口，仅接收读请求" },
        { path: "src/query/application/projections/projector.py", purpose: "投影器，订阅事件流并更新读模型" },
        { path: "src/query/infrastructure/read_model/repository.py", purpose: "读模型仓储" },
      ],
      configFile: "pyproject.toml",
    },
    {
      language: "go",
      directories: [
        "internal/command/api",
        "internal/command/application/handlers",
        "internal/command/domain/aggregates",
        "internal/command/domain/commands",
        "internal/command/domain/events",
        "internal/command/infrastructure/eventstore",
        "internal/query/api",
        "internal/query/application/queries",
        "internal/query/application/projections",
        "internal/query/infrastructure/readmodel",
        "internal/shared/events",
      ],
      entryFiles: [
        { path: "internal/command/api/handler.go", purpose: "命令侧 API 处理器，仅接收写请求" },
        {
          path: "internal/command/application/handlers/command_handler.go",
          purpose: "命令处理器，编排聚合根执行业务逻辑并产生事件",
        },
        {
          path: "internal/command/domain/aggregates/aggregate_root.go",
          purpose: "聚合根基类，封装状态转换方法 + 事件应用方法",
        },
        { path: "internal/command/infrastructure/eventstore/event_store.go", purpose: "事件存储实现，持久化事件流" },
        { path: "internal/query/api/handler.go", purpose: "查询侧 API 处理器，仅接收读请求" },
        { path: "internal/query/application/projections/projector.go", purpose: "投影器，订阅事件流并更新读模型" },
        { path: "internal/query/infrastructure/readmodel/repository.go", purpose: "读模型仓储" },
      ],
      configFile: "go.mod",
    },
  ],

  // 依赖规则：command 侧不得直接读 query 模型；事件订阅必须幂等
  dependencyRules: [
    {
      id: "DEP-CMD-Q-01",
      description:
        "命令侧（command）不得直接依赖查询侧（query）的读模型。" +
        "CQRS 的核心约束：写模型与读模型分离，命令侧只能通过聚合根重建事件流获取状态，" +
        "直接读取 query 模型将破坏读写分离，引入强一致耦合。",
      fromLayer: "command",
      forbiddenToLayers: ["query"],
      severity: "blocker",
    },
    {
      id: "DEP-Q-CMD-01",
      description:
        "查询侧（query）不得直接依赖命令侧（command）的聚合根或命令处理器。" +
        "query 侧仅通过订阅事件流更新读模型，直接调用 command 将破坏 CQRS 单向数据流，" +
        "导致读写循环依赖。",
      fromLayer: "query",
      forbiddenToLayers: ["command"],
      severity: "blocker",
    },
    {
      id: "DEP-CMD-ES-01",
      description:
        "命令侧的事件存储（event-store）不得被查询侧直接访问。" +
        "event-store 是写路径的持久化层，查询侧应通过事件总线订阅事件，" +
        "直接读取 event-store 将绕过事件分发机制，导致事件丢失或顺序错乱。",
      fromLayer: "query",
      forbiddenToLayers: ["command.infrastructure.event-store"],
      severity: "major",
    },
    {
      id: "DEP-AGG-01",
      description:
        "聚合根（aggregates）不得依赖事件存储基础设施。" +
        "聚合根应通过 apply 方法应用事件，事件持久化由命令处理器调用 event-store 完成。" +
        "聚合根直接依赖 event-store 将破坏聚合的可测试性与可重放性。",
      fromLayer: "command.domain.aggregates",
      forbiddenToLayers: ["command.infrastructure.event-store"],
      severity: "blocker",
    },
    {
      id: "DEP-PROJ-01",
      description:
        "投影器（projections）不得修改命令侧的聚合状态。" +
        "投影器是只读消费者，仅订阅事件并更新读模型。直接修改聚合状态将破坏事件溯源的" +
        "不可变性原则，导致事件流与聚合状态不一致。",
      fromLayer: "query.application.projections",
      forbiddenToLayers: ["command.domain.aggregates"],
      severity: "blocker",
    },
  ],

  // 命名规范：命令 XxxCommand、事件 XxxEvent、投影 XxxProjection
  namingConventions: [
    {
      element: "domain-event",
      pattern: "XxxEvent",
      description:
        "领域事件类名以 Event 后缀结尾（如 OrderCreatedEvent、OrderShippedEvent），" +
        "采用过去式动词描述已发生的事实，事件是不可变的，可被多个投影器订阅。",
    },
    {
      element: "application-service",
      pattern: "XxxCommandHandler 或 XxxCommand",
      description:
        "命令类名以 Command 后缀结尾（如 CreateOrderCommand），命令处理器以 CommandHandler " +
        "后缀结尾（如 CreateOrderCommandHandler）。命令是意图的表达，事件是事实的记录。",
    },
    {
      element: "aggregate-root",
      pattern: "XxxAggregate",
      description:
        "聚合根类名以 Aggregate 后缀结尾（如 OrderAggregate），聚合根封装状态转换方法" +
        "（如 markPaid()）与事件应用方法（如 applyOrderPaidEvent()），状态由事件重放重建。",
    },
    {
      element: "repository",
      pattern: "XxxEventStore / XxxReadModelRepository",
      description:
        "命令侧仓储以 EventStore 后缀结尾（如 OrderEventStore），持久化事件流；" +
        "查询侧仓储以 ReadModelRepository 后缀结尾（如 OrderReadModelRepository），" +
        "查询反范式化的读模型。两侧仓储不得混淆。",
    },
    {
      element: "factory",
      pattern: "XxxProjection 或 XxxProjector",
      description:
        "投影器类名以 Projection 或 Projector 后缀结尾（如 OrderProjection、OrderProjector），" +
        "标识事件订阅器，订阅事件流并更新读模型，需保证幂等性。",
    },
    {
      element: "value-object",
      pattern: "XxxValueObject 或 XxxVO",
      description:
        "值对象类名以 ValueObject 或 VO 后缀结尾（如 MoneyVO、AddressVO），" +
        "标识不可变的值对象，作为聚合根与命令的属性。",
    },
    {
      element: "entity",
      pattern: "XxxEntity 或 XxxReadModel",
      description:
        "查询侧实体以 ReadModel 后缀结尾（如 OrderReadModel、UserReadModel），" +
        "标识反范式化的读模型，与命令侧的聚合根区分。",
    },
  ],

  // 反模式清单：命令侧直接查询、事件缺失幂等
  antiPatterns: [
    {
      id: "AP-CMD-QUERY-01",
      name: "command-side-direct-query",
      description:
        "命令侧直接查询读模型——命令处理器调用 query 侧的 ReadModelRepository 获取状态。" +
        "违反 CQRS 读写分离原则，命令侧应通过聚合根重放事件获取状态。" +
        "直接查询读模型将引入强一致耦合与循环依赖（读模型是异步投影的，可能滞后）。",
      detection: "static",
      severity: "blocker",
    },
    {
      id: "AP-NO-IDEMP-01",
      name: "event-handler-missing-idempotency",
      description:
        "事件处理器缺失幂等性——投影器或事件订阅器未做幂等控制，重放事件将导致" +
        "读模型数据重复累加。应通过事件 ID + 处理记录表去重，或采用天然幂等的更新操作" +
        "（如 upsert）。违反将导致数据不一致。",
      detection: "reasoning",
      severity: "blocker",
    },
    {
      id: "AP-AGG-MUT-01",
      name: "aggregate-mutate-without-event",
      description:
        "聚合根状态变更未产生事件——直接修改聚合根字段而非通过事件应用方法。" +
        "违反事件溯源的核心约束：状态变更必须以事件形式记录，否则事件流无法重建状态，" +
        "审计与回放失效。",
      detection: "reasoning",
      severity: "blocker",
    },
    {
      id: "AP-PROJ-MUT-AGG-01",
      name: "projector-mutates-aggregate",
      description:
        "投影器修改聚合状态——投影器调用命令侧的聚合方法修改状态。" +
        "违反 CQRS 单向数据流：投影器是只读消费者，仅订阅事件并更新读模型。" +
        "直接修改聚合将破坏事件溯源的不可变性原则。",
      detection: "static",
      severity: "blocker",
    },
    {
      id: "AP-SNAP-MISS-01",
      name: "missing-snapshot-strategy",
      description:
        "缺少快照策略——聚合事件流过长（如超过 1000 个事件）时未做快照优化，" +
        "导致状态重建耗时过长。应定期生成快照（每 N 个事件或每 T 时间），" +
        "重建时从最近快照开始重放后续事件。本反模式为性能问题非正确性问题，" +
        "WARNING 提示。",
      detection: "reasoning",
      severity: "warning",
    },
  ],
} satisfies ArchitectureParadigm;

/**
 * CQRS + Event Sourcing 范式定义（冻结导出）
 *
 * 内部 _CQRS_ES_PARADIGM 已通过 `satisfies ArchitectureParadigm` 完整类型校验，
 * Object.freeze 冻结后对外导出，确保运行期不可被 LLM 自改。
 */
export const CQRS_ES_PARADIGM: ArchitectureParadigm = Object.freeze(_CQRS_ES_PARADIGM);
