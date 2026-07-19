/**
 * EAG-P1 批次 3 单元测试：DesignLoopOrchestrator 编排器
 *
 * 测试范围：
 * - O1. 完整流程通过场景（一次通过）—— PM → Architect → Evaluator（通过）→ HUMAN_CHECKPOINT
 * - O2. 评估失败重试场景——首次失败，第二次通过（验证迭代次数与重试机制）
 * - O3. 达到 maxIterations 仍未通过——返回失败结果
 * - O4. paradigm_lock 锁定场景——直接使用锁定范式（跳过信号匹配）
 * - O5. 配置 triggerHumanCheckpoint=false 时不触发 HUMAN_CHECKPOINT
 * - O6. 自主选择范式场景——按 StructuredRequirement 推导信号匹配范式
 * - O7. 多用户故事场景——PM 产出多个 UserStory，架构师设计多聚合承载
 * - O8. paradigm_lock 非法配置——orchestrator 抛出错误
 * - O9. 评估器 strict 模式——任一 finding 即不通过，触发重试
 *
 * 测试约定（严格遵循项目"禁止 mock"规则）：
 * - 使用 node:test + node:assert/strict
 * - 提供 StaticProductManager（implement ProductManagerProtocol）真实实现
 * - 提供 StaticArchitect（implement ArchitectProtocol）真实实现
 * - 提供 StaticDesignEvaluator（已在 design-evaluator.ts 实现）真实判定
 * - 不使用任何 mock 框架，所有组件为真实可运行的实现
 *
 * StaticProductManager 实现说明：
 * - 解析原始需求文本中的"作为X，我希望Y，以便Z"模式（中文用户故事模板）
 * - 一个需求文本可包含多个用户故事（按行分隔）
 * - 输出确定性的 StructuredRequirement（相同输入→相同输出）
 *
 * StaticArchitect 实现说明：
 * - 根据 StructuredRequirement 生成确定性的 ArchitectureDocument + DomainModelDocument
 * - 支持 paradigmLock 锁定场景：锁定时使用锁定的范式
 * - 支持失败重试场景：通过 failureIterations 参数控制前 N 次返回失败设计
 *   （状态化真实实现：架构师在重试中"改进"设计，非 mock）
 *
 * 设计依据：
 * - EAG 方案 §5.2.2 DESIGN Loop 角色编排：PM → 架构师 → 独立评估器
 * - EAG 方案 §5.2.2 人工检查点：设计文档生成后默认触发 1 次 HUMAN_CHECKPOINT
 * - EAG 方案 §5.1.1 范式选择防误判机制（paradigm_lock + 信号匹配 + 证据强制）
 * - eag/design/design-orchestrator.ts 源文件
 *
 * @module core/tests/eag-design-orchestrator
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { DesignLoopOrchestrator } from "../eag/design/design-orchestrator";
import { StaticDesignEvaluator } from "../eag/design/design-evaluator";
import { DDD_LAYERED_PARADIGM } from "../eag/eak/paradigms/ddd-layered";
import { CQRS_ES_PARADIGM } from "../eag/eak/paradigms/cqrs-es";
import { getParadigmById } from "../eag/eak/paradigm-registry";
import { createDefaultDesignLoopConfig } from "../eag/design/design-models";
import type { ProjectContext } from "../eag/design/design-models";
import type {
  DesignLoopInput,
  StructuredRequirement,
  ArchitectureDocument,
  DomainModelDocument,
  UserStory,
  DomainTerm,
  NonFunctionalRequirement,
} from "../eag/design/design-models";
import type { ProductManagerProtocol, ArchitectProtocol } from "../eag/design/design-protocols";
import type { ArchitectureParadigm, ParadigmId, ParadigmLockConfig } from "../eag/eak/types";

// ============================================================================
// 真实组件 1：StaticProductManager（implement ProductManagerProtocol）
// ============================================================================

/**
 * 静态产品经理（implement ProductManagerProtocol）
 *
 * 真实实现：解析原始需求文本中的"作为X，我希望Y，以便Z"模式，
 * 生成确定性的 StructuredRequirement。
 *
 * 解析规则（基于正则匹配，非 mock）：
 * - 按行扫描原始需求，匹配 "作为<角色>，我希望<动作>，以便<价值>" 模式
 * - 每个匹配行生成一个 UserStory，id 自增（US-001、US-002 ...）
 * - 从动作中提取领域事件候选（如"创建订单" → "OrderCreatedEvent"）
 * - 领域词汇表：从角色与动作中提取术语
 * - 非功能需求：扫描"强一致" / "高性能" / "可扩展" 等关键词
 *
 * 输出确定性：相同输入文本→相同输出 StructuredRequirement（无随机性）。
 */
class StaticProductManager implements ProductManagerProtocol {
  /**
   * 解析原始需求并生成结构化需求
   *
   * @param rawRequirement 原始需求文本（多行，每行一个用户故事）
   * @param _projectContext 项目上下文（本静态实现未使用，保留参数对齐协议）
   * @returns 确定性的 StructuredRequirement
   */
  async structureRequirement(rawRequirement: string, _projectContext?: ProjectContext): Promise<StructuredRequirement> {
    // 按行切分，去掉空行
    const lines = rawRequirement
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    const userStories: UserStory[] = [];
    // 使用可变数组类型（DomainTerm[] / NonFunctionalRequirement[]）而非 StructuredRequirement 上的 readonly 派生类型，
    // 以便在循环中调用 push 累积解析结果，最终在 return 时由 StructuredRequirement 的 readonly 字段接收（协变安全）
    const domainGlossary: DomainTerm[] = [];
    const nonFunctionalRequirements: NonFunctionalRequirement[] = [];

    // 用户故事计数器（用于生成 US-001、US-002 ...）
    let storyIndex = 0;

    // 用户故事正则：作为<角色>，我希望<动作>，以便<价值>
    const storyPattern = /作为(.+?)，\s*我希望(.+?)，\s*以便(.+)/;

    for (const line of lines) {
      const match = line.match(storyPattern);
      if (match) {
        storyIndex += 1;
        const role = match[1].trim();
        const action = match[2].trim();
        const benefit = match[3].trim();

        // 从动作中提取领域事件候选：将"创建订单"转为"OrderCreatedEvent"
        // 规则：动词+名词 → Noun+Verb+Event（简化规则，确定性转换）
        const domainEventCandidate = this.extractDomainEventCandidate(action);

        userStories.push({
          id: `US-${String(storyIndex).padStart(3, "0")}`,
          role,
          action,
          benefit,
          acceptanceCriteria: [
            {
              id: `AC-${String(storyIndex).padStart(3, "0")}`,
              given: `${role}已就绪`,
              when: `${action}`,
              then: `达成${benefit}`,
            },
          ],
          domainEventCandidates: domainEventCandidate ? [domainEventCandidate] : [],
        });

        // 从角色与动作中提取领域词汇
        domainGlossary.push({
          term: action,
          definition: `${role}执行的业务动作`,
          synonyms: [],
        });
      }

      // 扫描非功能需求关键词
      if (line.includes("强一致")) {
        nonFunctionalRequirements.push({
          id: `NFR-${String(nonFunctionalRequirements.length + 1).padStart(3, "0")}`,
          category: "consistency",
          description: "需求要求强一致",
        });
      }
      if (line.includes("高性能")) {
        nonFunctionalRequirements.push({
          id: `NFR-${String(nonFunctionalRequirements.length + 1).padStart(3, "0")}`,
          category: "performance",
          description: "需求要求高性能",
        });
      }
    }

    return {
      userStories,
      domainGlossary,
      nonFunctionalRequirements,
    };
  }

  /**
   * 从动作文本提取领域事件候选名
   *
   * 规则：动作="创建订单" → 事件名="OrderCreatedEvent"
   * 实现：通过预定义的动词映射 + 名词转 PascalCase 拼装。
   * 简化但确定性——非 mock，真实基于输入文本生成。
   *
   * @param action 动作文本（如"创建订单"）
   * @returns 领域事件候选名（如"OrderCreatedEvent"）；无法识别时返回 null
   */
  private extractDomainEventCandidate(action: string): string | null {
    // 中文动词 → 英文动词过去分词映射
    const verbMap: Readonly<Record<string, string>> = {
      创建: "Created",
      修改: "Updated",
      更新: "Updated",
      删除: "Deleted",
      取消: "Cancelled",
      确认: "Confirmed",
      提交: "Submitted",
      支付: "Paid",
      发货: "Shipped",
      收货: "Received",
    };

    // 中文名词 → 英文名词映射（覆盖常见业务术语）
    const nounMap: Readonly<Record<string, string>> = {
      订单: "Order",
      用户: "User",
      商品: "Product",
      库存: "Inventory",
      支付: "Payment",
      仓库: "Warehouse",
      物流: "Logistics",
      客户: "Customer",
    };

    // 在动作文本中查找动词与名词
    let verb: string | null = null;
    let noun: string | null = null;
    for (const [cn, en] of Object.entries(verbMap)) {
      if (action.includes(cn)) {
        verb = en;
        break;
      }
    }
    for (const [cn, en] of Object.entries(nounMap)) {
      if (action.includes(cn)) {
        noun = en;
        break;
      }
    }

    // 动词或名词缺失时返回 null
    if (!verb || !noun) return null;
    return `${noun}${verb}Event`;
  }
}

// ============================================================================
// 真实组件 2：StaticArchitect（implement ArchitectProtocol）
// ============================================================================

/**
 * 静态架构师（implement ArchitectProtocol）
 *
 * 真实实现：根据 StructuredRequirement 生成确定性的 ArchitectureDocument + DomainModelDocument。
 *
 * 状态化设计（用于测试重试场景，非 mock）：
 * - 内部维护 callCount 计数器，每次 designArchitecture 调用自增
 * - 通过 failureIterations 参数控制前 N 次返回"失败设计"（如 selectedParadigmId 不一致）
 * - 第 N+1 次起返回"通过设计"
 * - 这模拟了"架构师根据评估反馈改进设计"的真实场景
 *
 * 范式选择规则：
 * - paradigmLock.locked=true → 使用锁定的范式
 * - 否则 → 默认使用 DDD_LAYERED_PARADIGM（DDD 在 PARADIGM_IDS 中优先级最高）
 *
 * 设计产出规则：
 * - architectureDocument.selectedParadigmId 与所选范式一致（除非"失败设计"模式）
 * - architectureDocument.dependencyRules 直接引用范式定义的 dependencyRules
 * - architectureDocument.layering 覆盖范式 dependencyRules 涉及的全部层
 * - architectureDocument.signalEvidence 自主选择时填充（锁定时为空）
 * - domainModelDocument.aggregates / entities / domainEvents 根据 UserStory 推导
 */
class StaticArchitect implements ArchitectProtocol {
  /** 当前调用次数（每次 designArchitecture 自增） */
  private callCount = 0;

  /**
   * @param failureIterations 前 N 次返回失败设计（默认 0，即始终返回通过设计）
   * @param failureParadigmId 失败设计使用的错误范式 ID（默认 "clean-architecture"，与 DDD 不一致触发失败）
   */
  constructor(
    private readonly failureIterations: number = 0,
    private readonly failureParadigmId: ParadigmId = "clean-architecture"
  ) {}

  /**
   * 根据结构化需求产出架构设计文档 + 领域模型文档
   *
   * @param requirement PM 产出的结构化需求
   * @param paradigmLock 可选，paradigm_lock 配置
   * @param _projectContext 项目上下文（本静态实现未使用）
   * @returns 架构师产出：architecture + domainModel
   */
  async designArchitecture(
    requirement: StructuredRequirement,
    paradigmLock?: ParadigmLockConfig,
    _projectContext?: ProjectContext
  ): Promise<{ architecture: ArchitectureDocument; domainModel: DomainModelDocument }> {
    this.callCount += 1;

    // 选择范式：锁定时使用锁定的范式，否则使用 DDD（优先级最高）
    const paradigm: ArchitectureParadigm =
      paradigmLock && paradigmLock.locked && paradigmLock.paradigmId
        ? getParadigmById(paradigmLock.paradigmId)!
        : DDD_LAYERED_PARADIGM;

    // 判定本次是否为"失败设计"（前 failureIterations 次返回失败设计）
    const isFailureDesign = this.callCount <= this.failureIterations;
    // 失败设计：故意使用错误的 selectedParadigmId 触发评估器范式一致性失败
    const selectedParadigmId: ParadigmId = isFailureDesign ? this.failureParadigmId : paradigm.id;

    // 构造 ArchitectureDocument
    const architecture: ArchitectureDocument = {
      selectedParadigmId,
      paradigmRationale: `${paradigm.name} 范式匹配当前业务需求`,
      // 自主选择时填充信号证据（锁定时为空，评估器在锁定场景下跳过证据判定）
      signalEvidence:
        paradigmLock && paradigmLock.locked
          ? {}
          : {
              domainComplexity: "需求中包含多个业务实体与状态转换，业务复杂度高",
              consistencyRequirement: "需求要求订单状态强一致",
              readWritePattern: "读写均衡，订单查询与创建均频繁",
              integrationComplexity: "单体应用，无外部系统集成",
            },
      boundedContexts: [
        {
          name: "核心上下文",
          responsibility: "承载核心业务逻辑",
          aggregates: requirement.userStories.map((_, idx) => `Aggregate${idx + 1}`),
        },
      ],
      // 根据 paradigm.id 生成对应范式的 layering
      layering: this.buildLayering(paradigm.id),
      // 直接引用范式定义的 dependencyRules，保证一致性
      dependencyRules: paradigm.dependencyRules,
    };

    // 构造 DomainModelDocument：根据 UserStory 推导聚合/实体/事件
    // 注意：聚合的 publishedEvents 直接复用 UserStory 的 domainEventCandidates，
    // 不做 fallback——若 PM 未提供候选事件，聚合 publishedEvents 为空，
    // 在 CQRS-ES 范式下会触发 AP-AGG-MUT-01 反模式（这是真实业务约束的体现，非 mock）
    const aggregates = requirement.userStories.map((story, idx) => {
      const aggName = `Aggregate${idx + 1}`;
      return {
        name: aggName,
        rootEntity: `${aggName}Entity`,
        invariants: [`${aggName} 状态转换必须符合业务规则`],
        containedEntities: [],
        valueObjects: [],
        publishedEvents: [...story.domainEventCandidates],
      };
    });

    const entities = requirement.userStories.map((story, idx) => {
      const aggName = `Aggregate${idx + 1}`;
      return {
        name: `${aggName}Entity`,
        aggregate: aggName,
        attributes: [{ name: "id", type: "string", required: true }],
        behaviors: [
          {
            name: "execute",
            description: `执行${story.action}`,
            publishedEvents: story.domainEventCandidates,
          },
        ],
      };
    });

    const domainEvents = requirement.userStories.flatMap((story, idx) => {
      const aggName = `Aggregate${idx + 1}`;
      return story.domainEventCandidates.map((evtName) => ({
        name: evtName,
        publisher: aggName,
        subscribers: [],
        payload: [{ name: "id", type: "string", required: true }],
      }));
    });

    const domainModel: DomainModelDocument = {
      aggregates,
      entities,
      valueObjects: [
        {
          name: "IdentifierVO",
          attributes: [{ name: "value", type: "string", required: true }],
          immutabilityGuarantee: "所有字段 readonly + Object.freeze 冻结",
        },
      ],
      domainEvents,
    };

    return { architecture, domainModel };
  }

  /**
   * 根据 paradigmId 构造对应范式的分层定义
   *
   * 分层定义必须覆盖范式 dependencyRules 中 fromLayer 与 forbiddenToLayers 涉及的全部层，
   * 否则评估器的"范式一致性"判定会因 layering 缺失层而打回。
   *
   * 同时各层的 allowedDependencies 不得触发范式的静态反模式：
   * - DDD: domain 层不得依赖 infrastructure（AP-DOM-ORM-01）
   * - Clean Architecture: entities 不得依赖 frameworks（AP-ENT-FRAMEWORK-01）；
   *   use-cases 不得依赖 frameworks（AP-UC-DI-01）；
   *   frameworks 不得依赖 use-cases（AP-BYPASS-ADP-01）
   * - CQRS-ES: command-side 不得依赖 query-side/read-side（AP-CMD-QUERY-01）
   *
   * @param paradigmId 范式 ID
   * @returns 分层定义列表（覆盖范式 dependencyRules 涉及的全部层，且不触发静态反模式）
   */
  private buildLayering(paradigmId: ParadigmId): ArchitectureDocument["layering"] {
    if (paradigmId === "ddd-layered") {
      // DDD dependencyRules 涉及：domain / application / interfaces / infrastructure
      return [
        { name: "domain", responsibility: "领域模型，零外部依赖", allowedDependencies: [] },
        { name: "application", responsibility: "应用编排", allowedDependencies: ["domain"] },
        { name: "interfaces", responsibility: "接口适配", allowedDependencies: ["application", "domain"] },
        { name: "infrastructure", responsibility: "基础设施", allowedDependencies: ["domain", "application"] },
      ];
    }
    if (paradigmId === "clean-architecture") {
      // Clean Architecture dependencyRules 涉及：
      // entities / use-cases / adapters / frameworks / adapters.impl / frameworks.impl / external-libs
      // 注意：frameworks 层 allowedDependencies 不得包含 use-cases（避免触发 AP-BYPASS-ADP-01）
      return [
        { name: "entities", responsibility: "实体层，零外部依赖", allowedDependencies: [] },
        { name: "use-cases", responsibility: "用例层", allowedDependencies: ["entities"] },
        { name: "adapters", responsibility: "适配器层", allowedDependencies: ["use-cases", "entities"] },
        { name: "frameworks", responsibility: "框架层", allowedDependencies: ["adapters", "entities"] },
        // 补充 dependencyRules 中涉及但未在主分层出现的层（占位层，保证评估器覆盖性判定通过）
        { name: "adapters.impl", responsibility: "适配器实现层（占位）", allowedDependencies: ["adapters"] },
        { name: "frameworks.impl", responsibility: "框架实现层（占位）", allowedDependencies: ["frameworks"] },
        { name: "external-libs", responsibility: "外部库层（占位）", allowedDependencies: [] },
      ];
    }
    if (paradigmId === "cqrs-es") {
      // CQRS-ES dependencyRules 涉及：
      // command / query / command.infrastructure.event-store /
      // command.domain.aggregates / query.application.projections
      // 注意：command 层 allowedDependencies 不得包含 query/read-side（避免触发 AP-CMD-QUERY-01）
      return [
        { name: "command", responsibility: "命令侧，处理写操作", allowedDependencies: [] },
        { name: "query", responsibility: "查询侧，处理读操作", allowedDependencies: [] },
        { name: "command.infrastructure.event-store", responsibility: "事件存储层", allowedDependencies: ["command"] },
        { name: "command.domain.aggregates", responsibility: "聚合根层", allowedDependencies: [] },
        { name: "query.application.projections", responsibility: "投影器层", allowedDependencies: ["query"] },
      ];
    }
    // microservice：dependencyRules 涉及 services.order / services.user / services.inventory /
    // services.order.infrastructure / services.user.infrastructure.database / gateway / saga / shared
    return [
      { name: "gateway", responsibility: "网关层", allowedDependencies: [] },
      { name: "services.order", responsibility: "订单服务", allowedDependencies: [] },
      { name: "services.user", responsibility: "用户服务", allowedDependencies: [] },
      { name: "services.inventory", responsibility: "库存服务", allowedDependencies: [] },
      {
        name: "services.order.infrastructure",
        responsibility: "订单服务基础设施",
        allowedDependencies: ["services.order"],
      },
      {
        name: "services.user.infrastructure.database",
        responsibility: "用户服务数据库",
        allowedDependencies: ["services.user"],
      },
      { name: "saga", responsibility: "Saga 编排层", allowedDependencies: [] },
      { name: "shared", responsibility: "共享层", allowedDependencies: [] },
    ];
  }
}

// ============================================================================
// 测试辅助：构造测试输入
// ============================================================================

/**
 * 构造一个标准的原始需求文本（单用户故事）
 *
 * @returns 标准原始需求文本
 */
function buildSimpleRawRequirement(): string {
  return "作为订单管理员，我希望创建订单，以便跟踪订单状态";
}

/**
 * 构造一个多用户故事的原始需求文本
 *
 * @returns 多用户故事原始需求文本
 */
function buildMultiStoryRawRequirement(): string {
  return [
    "作为订单管理员，我希望创建订单，以便跟踪订单状态",
    "作为订单管理员，我希望确认订单，以便推进订单状态",
    "作为财务管理员，我希望支付订单，以便完成订单结算",
  ].join("\n");
}

// ============================================================================
// O1. 完整流程通过场景（一次通过）
// ============================================================================

test("O1. 完整流程通过场景——PM → Architect → Evaluator 通过 → HUMAN_CHECKPOINT 触发", async () => {
  const pm = new StaticProductManager();
  const architect = new StaticArchitect(); // 默认 failureIterations=0，始终通过
  const evaluator = new StaticDesignEvaluator("strict", false);
  const orchestrator = new DesignLoopOrchestrator(pm, architect, evaluator);

  const input: DesignLoopInput = {
    rawRequirement: buildSimpleRawRequirement(),
  };
  const result = await orchestrator.run(input);

  // 评估应通过
  assert.equal(
    result.evaluationVerdict.passed,
    true,
    `应通过，但 findings: ${result.evaluationVerdict.findings.join("; ")}`
  );
  // 应触发人工检查点（默认配置 triggerHumanCheckpoint=true）
  assert.equal(result.humanCheckpointTriggered, true);
  // 应一次通过（iterations=1）
  assert.equal(result.iterations, 1);
  // 产出物应完整
  assert.ok(result.artifacts.structuredRequirement.userStories.length > 0);
  assert.ok(result.artifacts.architectureDocument.selectedParadigmId);
  assert.ok(result.artifacts.domainModelDocument.aggregates.length > 0);
});

// ============================================================================
// O2. 评估失败重试场景——首次失败，第二次通过
// ============================================================================

test("O2. 评估失败重试场景——首次失败，第二次通过（iterations=2）", async () => {
  const pm = new StaticProductManager();
  // failureIterations=1：第一次返回失败设计（selectedParadigmId 不一致），第二次返回通过设计
  const architect = new StaticArchitect(1);
  const evaluator = new StaticDesignEvaluator("strict", false);
  const orchestrator = new DesignLoopOrchestrator(pm, architect, evaluator);

  const input: DesignLoopInput = {
    rawRequirement: buildSimpleRawRequirement(),
  };
  const result = await orchestrator.run(input);

  // 最终应通过（第二次重试通过）
  assert.equal(
    result.evaluationVerdict.passed,
    true,
    `应通过，但 findings: ${result.evaluationVerdict.findings.join("; ")}`
  );
  // 应迭代 2 次（首次失败 + 第二次通过）
  assert.equal(result.iterations, 2);
  // 应触发人工检查点（评估通过后触发）
  assert.equal(result.humanCheckpointTriggered, true);
});

// ============================================================================
// O3. 达到 maxIterations 仍未通过——返回失败结果
// ============================================================================

test("O3. 达到 maxIterations 仍未通过——返回失败结果，iterations=maxIterations", async () => {
  const pm = new StaticProductManager();
  // failureIterations=10：始终返回失败设计（远超 maxIterations）
  const architect = new StaticArchitect(10);
  const evaluator = new StaticDesignEvaluator("strict", false);
  // maxIterations=2：限制最大迭代次数为 2
  const config = createDefaultDesignLoopConfig({ maxIterations: 2 });
  const orchestrator = new DesignLoopOrchestrator(pm, architect, evaluator, config);

  const input: DesignLoopInput = {
    rawRequirement: buildSimpleRawRequirement(),
  };
  const result = await orchestrator.run(input);

  // 应未通过
  assert.equal(result.evaluationVerdict.passed, false, "应未通过");
  // 应迭代到 maxIterations（2 次）后停止
  assert.equal(result.iterations, 2);
  // 未通过时不应触发人工检查点
  assert.equal(result.humanCheckpointTriggered, false);
  // 应有失败原因
  assert.ok(result.evaluationVerdict.findings.length > 0);
  assert.ok(result.evaluationVerdict.reason.includes("未通过"));
});

// ============================================================================
// O4. paradigm_lock 锁定场景——直接使用锁定范式
// ============================================================================

test("O4. paradigm_lock 锁定场景——使用锁定的范式，跳过信号匹配", async () => {
  const pm = new StaticProductManager();
  // failureIterations=0：始终返回通过设计
  // 注意：StaticArchitect 在锁定场景下会使用锁定的范式
  const architect = new StaticArchitect();
  // 锁定场景：paradigmLocked=true 跳过 signalEvidence 证据判定
  const evaluator = new StaticDesignEvaluator("strict", true);
  const orchestrator = new DesignLoopOrchestrator(pm, architect, evaluator);

  // 锁定 CQRS-ES 范式
  const paradigmLock: ParadigmLockConfig = {
    locked: true,
    paradigmId: "cqrs-es",
    reason: "组织规范要求使用 CQRS-ES 范式",
  };
  const input: DesignLoopInput = {
    rawRequirement: buildSimpleRawRequirement(),
    paradigmLock,
  };
  const result = await orchestrator.run(input);

  // 评估应通过（锁定场景跳过 signalEvidence 证据判定）
  assert.equal(
    result.evaluationVerdict.passed,
    true,
    `应通过，但 findings: ${result.evaluationVerdict.findings.join("; ")}`
  );
  // 应一次通过
  assert.equal(result.iterations, 1);
  // 架构文档应使用锁定的范式（CQRS-ES）
  assert.equal(result.artifacts.architectureDocument.selectedParadigmId, "cqrs-es");
  // 应触发人工检查点
  assert.equal(result.humanCheckpointTriggered, true);
});

// ============================================================================
// O5. 配置 triggerHumanCheckpoint=false 时不触发 HUMAN_CHECKPOINT
// ============================================================================

test("O5. 配置 triggerHumanCheckpoint=false——评估通过但不触发人工检查点", async () => {
  const pm = new StaticProductManager();
  const architect = new StaticArchitect();
  const evaluator = new StaticDesignEvaluator("strict", false);
  // triggerHumanCheckpoint=false：评估通过后不触发人工检查点
  const config = createDefaultDesignLoopConfig({ triggerHumanCheckpoint: false });
  const orchestrator = new DesignLoopOrchestrator(pm, architect, evaluator, config);

  const input: DesignLoopInput = {
    rawRequirement: buildSimpleRawRequirement(),
  };
  const result = await orchestrator.run(input);

  // 评估应通过
  assert.equal(result.evaluationVerdict.passed, true);
  // 应一次通过
  assert.equal(result.iterations, 1);
  // 不应触发人工检查点
  assert.equal(result.humanCheckpointTriggered, false);
});

// ============================================================================
// O6. 自主选择范式场景——按 StructuredRequirement 推导信号匹配范式
// ============================================================================

test("O6. 自主选择范式场景——orchestrator 按需求推导信号并选择范式", async () => {
  const pm = new StaticProductManager();
  const architect = new StaticArchitect();
  const evaluator = new StaticDesignEvaluator("strict", false);
  const orchestrator = new DesignLoopOrchestrator(pm, architect, evaluator);

  // 不提供 paradigmLock，orchestrator 应自主选择范式
  // StaticProductManager 解析"创建订单"→ 1 个 UserStory → domainComplexity=low
  // 但 StaticArchitect 默认使用 DDD 范式（与 orchestrator 选择的范式可能不同）
  // 这里只验证 orchestrator 能正常完成流程
  const input: DesignLoopInput = {
    rawRequirement: buildSimpleRawRequirement(),
  };
  const result = await orchestrator.run(input);

  // 应通过（StaticArchitect 默认使用 DDD 范式，与评估器入参一致）
  assert.equal(
    result.evaluationVerdict.passed,
    true,
    `应通过，但 findings: ${result.evaluationVerdict.findings.join("; ")}`
  );
  // 应一次通过
  assert.equal(result.iterations, 1);
});

// ============================================================================
// O7. 多用户故事场景——PM 产出多个 UserStory，架构师设计多聚合承载
// ============================================================================

test("O7. 多用户故事场景——PM 产出 3 个 UserStory，架构师设计 3 个聚合", async () => {
  const pm = new StaticProductManager();
  const architect = new StaticArchitect();
  const evaluator = new StaticDesignEvaluator("strict", false);
  const orchestrator = new DesignLoopOrchestrator(pm, architect, evaluator);

  const input: DesignLoopInput = {
    rawRequirement: buildMultiStoryRawRequirement(),
  };
  const result = await orchestrator.run(input);

  // 应通过
  assert.equal(
    result.evaluationVerdict.passed,
    true,
    `应通过，但 findings: ${result.evaluationVerdict.findings.join("; ")}`
  );
  // PM 应产出 3 个 UserStory
  assert.equal(result.artifacts.structuredRequirement.userStories.length, 3);
  // 架构师应为每个 UserStory 设计 1 个聚合（3 个聚合）
  assert.equal(result.artifacts.domainModelDocument.aggregates.length, 3);
  // 应一次通过
  assert.equal(result.iterations, 1);
  // 应触发人工检查点
  assert.equal(result.humanCheckpointTriggered, true);
});

// ============================================================================
// O8. paradigm_lock 非法配置——orchestrator 抛出错误
// ============================================================================

test("O8. paradigm_lock 非法配置——locked=true 但 paradigmId=null 时应抛错", async () => {
  const pm = new StaticProductManager();
  const architect = new StaticArchitect();
  const evaluator = new StaticDesignEvaluator("strict", true);
  const orchestrator = new DesignLoopOrchestrator(pm, architect, evaluator);

  // 非法配置：locked=true 但 paradigmId=null
  const invalidLock: ParadigmLockConfig = {
    locked: true,
    paradigmId: null,
    reason: "测试非法配置",
  };
  const input: DesignLoopInput = {
    rawRequirement: buildSimpleRawRequirement(),
    paradigmLock: invalidLock,
  };

  // 应抛错（validateParadigmLock 校验失败 → orchestrator 抛 Error）
  await assert.rejects(
    () => orchestrator.run(input),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok((err as Error).message.includes("paradigm_lock 配置非法"));
      return true;
    }
  );
});

test("O8b. paradigm_lock 非法配置——reason 为空时应抛错", async () => {
  const pm = new StaticProductManager();
  const architect = new StaticArchitect();
  const evaluator = new StaticDesignEvaluator("strict", true);
  const orchestrator = new DesignLoopOrchestrator(pm, architect, evaluator);

  // 非法配置：locked=true 但 reason 为空
  const invalidLock: ParadigmLockConfig = {
    locked: true,
    paradigmId: "ddd-layered",
    reason: "   ", // 空白字符串
  };
  const input: DesignLoopInput = {
    rawRequirement: buildSimpleRawRequirement(),
    paradigmLock: invalidLock,
  };

  await assert.rejects(
    () => orchestrator.run(input),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok((err as Error).message.includes("paradigm_lock 配置非法"));
      return true;
    }
  );
});

// ============================================================================
// O9. 评估器 strict 模式——任一 finding 即不通过，触发重试
// ============================================================================

test("O9. 评估器 strict 模式——首次失败设计触发重试，第二次通过", async () => {
  const pm = new StaticProductManager();
  const architect = new StaticArchitect(1); // 首次失败设计
  // strict 模式：任一 finding（含 warning）即不通过
  const evaluator = new StaticDesignEvaluator("strict", false);
  const orchestrator = new DesignLoopOrchestrator(pm, architect, evaluator);

  const input: DesignLoopInput = {
    rawRequirement: buildSimpleRawRequirement(),
  };
  const result = await orchestrator.run(input);

  // 最终应通过（第二次重试通过）
  assert.equal(result.evaluationVerdict.passed, true);
  // 应迭代 2 次
  assert.equal(result.iterations, 2);
  // 应触发人工检查点
  assert.equal(result.humanCheckpointTriggered, true);
});

// ============================================================================
// O10. 端到端：多范式锁定场景——锁定 Clean Architecture
// ============================================================================

test("O10. 端到端多范式锁定——锁定 Clean Architecture 范式", async () => {
  const pm = new StaticProductManager();
  const architect = new StaticArchitect();
  const evaluator = new StaticDesignEvaluator("strict", true);
  const orchestrator = new DesignLoopOrchestrator(pm, architect, evaluator);

  // 锁定 Clean Architecture 范式
  const paradigmLock: ParadigmLockConfig = {
    locked: true,
    paradigmId: "clean-architecture",
    reason: "组织规范要求使用 Clean Architecture",
  };
  const input: DesignLoopInput = {
    rawRequirement: buildSimpleRawRequirement(),
    paradigmLock,
  };
  const result = await orchestrator.run(input);

  // 应通过
  assert.equal(
    result.evaluationVerdict.passed,
    true,
    `应通过，但 findings: ${result.evaluationVerdict.findings.join("; ")}`
  );
  // 架构文档应使用锁定的范式
  assert.equal(result.artifacts.architectureDocument.selectedParadigmId, "clean-architecture");
  // 应一次通过
  assert.equal(result.iterations, 1);
});

// ============================================================================
// O11. 端到端：完整 DesignLoopResult 字段验证
// ============================================================================

test("O11. 端到端 DesignLoopResult 字段验证——input/artifacts/verdict/checkpoint/iterations 全部填充", async () => {
  const pm = new StaticProductManager();
  const architect = new StaticArchitect();
  const evaluator = new StaticDesignEvaluator("strict", false);
  const orchestrator = new DesignLoopOrchestrator(pm, architect, evaluator);

  const input: DesignLoopInput = {
    rawRequirement: buildSimpleRawRequirement(),
  };
  const result = await orchestrator.run(input);

  // input 应原样回传
  assert.equal(result.input.rawRequirement, buildSimpleRawRequirement());
  // artifacts 应完整
  assert.ok(result.artifacts.structuredRequirement);
  assert.ok(result.artifacts.architectureDocument);
  assert.ok(result.artifacts.domainModelDocument);
  // evaluationVerdict 应完整
  assert.equal(typeof result.evaluationVerdict.passed, "boolean");
  assert.equal(typeof result.evaluationVerdict.reason, "string");
  assert.ok(["blocker", "major", "warning"].includes(result.evaluationVerdict.severity));
  assert.ok(Array.isArray(result.evaluationVerdict.findings));
  assert.equal(typeof result.evaluationVerdict.suggestedFix, "string");
  // humanCheckpointTriggered 应为 boolean
  assert.equal(typeof result.humanCheckpointTriggered, "boolean");
  // iterations 应为正整数
  assert.equal(typeof result.iterations, "number");
  assert.ok(result.iterations >= 1);
});

// ============================================================================
// O12. lenient 评估器模式——blocker 仍不通过，触发重试
// ============================================================================

test("O12. lenient 评估器模式——首次 blocker 级失败触发重试，第二次通过", async () => {
  const pm = new StaticProductManager();
  // 首次返回失败设计（selectedParadigmId 不一致 → blocker 级失败）
  const architect = new StaticArchitect(1);
  // lenient 模式：仅 blocker 级 finding 不通过
  const evaluator = new StaticDesignEvaluator("lenient", false);
  const orchestrator = new DesignLoopOrchestrator(pm, architect, evaluator);

  const input: DesignLoopInput = {
    rawRequirement: buildSimpleRawRequirement(),
  };
  const result = await orchestrator.run(input);

  // 最终应通过（第二次重试通过）
  assert.equal(result.evaluationVerdict.passed, true);
  // 应迭代 2 次
  assert.equal(result.iterations, 2);
});

// ============================================================================
// O13. CQRS-ES 范式反模式命中场景——评估器检测到 AP-AGG-MUT-01
// ============================================================================

test("O13. CQRS-ES 范式反模式——聚合 publishedEvents 为空时命中 AP-AGG-MUT-01", async () => {
  const pm = new StaticProductManager();
  const architect = new StaticArchitect();
  // 锁定场景：paradigmLocked=true 跳过 signalEvidence 证据判定
  const evaluator = new StaticDesignEvaluator("strict", true);
  const orchestrator = new DesignLoopOrchestrator(pm, architect, evaluator);

  // 锁定 CQRS-ES 范式
  const paradigmLock: ParadigmLockConfig = {
    locked: true,
    paradigmId: "cqrs-es",
    reason: "测试 CQRS-ES 范式反模式",
  };

  // 使用不包含领域事件候选的需求，让 StaticProductManager 产出 domainEventCandidates 为空的 UserStory
  // 这样 StaticArchitect 生成的聚合 publishedEvents 也会为空，命中 AP-AGG-MUT-01
  const input: DesignLoopInput = {
    rawRequirement: "作为用户，我希望执行操作，以便达成目标", // 动作"执行操作"无法匹配 verbMap/nounMap
    paradigmLock,
  };
  const result = await orchestrator.run(input);

  // 应未通过（AP-AGG-MUT-01 命中）
  assert.equal(result.evaluationVerdict.passed, false, "CQRS-ES 范式下聚合无发布事件应命中 AP-AGG-MUT-01");
  // 应有 AP-AGG-MUT-01 命中记录
  assert.ok(
    result.evaluationVerdict.findings.some((f) => f.includes("AP-AGG-MUT-01")),
    `findings 应包含 AP-AGG-MUT-01，但实际：${result.evaluationVerdict.findings.join("; ")}`
  );
  // 应迭代到 maxIterations（默认 3）后停止
  assert.equal(result.iterations, 3);
});
