/**
 * EAG-P1 批次 3 单元测试：DESIGN Loop 数据模型
 *
 * 测试范围：
 * - M1. DesignLoopInput 接口字段完整性
 * - M2. ProjectContext 接口字段完整性
 * - M3. UserStory / AcceptanceCriterion 接口字段完整性
 * - M4. StructuredRequirement / DomainTerm / NonFunctionalRequirement 接口字段完整性
 * - M5. ArchitectureDocument / BoundedContext / LayerDefinition 接口字段完整性
 * - M6. DomainModelDocument / AggregateDefinition / EntityDefinition / ValueObjectDefinition /
 *       DomainEventDefinition / AttributeDefinition / BehaviorDefinition 接口字段完整性
 * - M7. DesignArtifacts / DesignEvaluationVerdict / DesignLoopResult 接口字段完整性
 * - M8. DesignLoopConfig 接口字段完整性 + DEFAULT_DESIGN_LOOP_CONFIG 默认值
 * - M9. createDefaultDesignLoopConfig 工厂函数
 *   - M9a. 默认配置
 *   - M9b. 部分覆盖
 *   - M9c. 冻结保证（Object.isFrozen）
 *   - M9d. 非法 maxIterations 抛错
 *   - M9e. 非法 triggerHumanCheckpoint 抛错
 *   - M9f. 非法 evaluationMode 抛错
 * - M10. 不可变保证：常量 Object.isFrozen
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止 mock，直接构造真实对象
 * - 测试用例独立、可重复
 *
 * 设计依据：
 * - EAG 方案 §5.2.2 DESIGN Loop（输入/产出物/评估器判定/人工检查点）
 * - eag/design/design-models.ts 源文件
 *
 * @module core/tests/eag-design-models
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_DESIGN_LOOP_CONFIG,
  DesignLoopConfigError,
  createDefaultDesignLoopConfig,
} from "../eag/design/design-models";
import type {
  DesignLoopInput,
  ProjectContext,
  UserStory,
  AcceptanceCriterion,
  DomainTerm,
  NonFunctionalRequirement,
  StructuredRequirement,
  BoundedContext,
  LayerDefinition,
  ArchitectureDocument,
  AttributeDefinition,
  BehaviorDefinition,
  AggregateDefinition,
  EntityDefinition,
  ValueObjectDefinition,
  DomainEventDefinition,
  DomainModelDocument,
  DesignArtifacts,
  DesignEvaluationVerdict,
  DesignLoopResult,
  DesignLoopConfig,
} from "../eag/design/design-models";

// ============================================================================
// M1. DesignLoopInput 接口字段完整性
// ============================================================================

test("M1. DesignLoopInput 接口字段完整性——构造完整对象", () => {
  const input: DesignLoopInput = {
    rawRequirement: "作为订单管理员，我希望创建订单以跟踪订单状态",
    projectContext: {
      projectRoot: "/tmp/project",
      existingParadigm: "ddd-layered",
      existingDomainModelUri: "file:///tmp/project/docs/eag/design/DOMAIN-MODEL.md",
    },
    paradigmLock: {
      locked: true,
      paradigmId: "ddd-layered",
      reason: "组织规范要求",
    },
  };
  assert.equal(input.rawRequirement.length > 0, true);
  assert.equal(input.projectContext?.existingParadigm, "ddd-layered");
  assert.equal(input.paradigmLock?.locked, true);
});

test("M1b. DesignLoopInput 绿地场景——projectContext 与 paradigmLock 可省略", () => {
  const input: DesignLoopInput = {
    rawRequirement: "作为用户，我希望登录",
  };
  assert.equal(input.projectContext, undefined);
  assert.equal(input.paradigmLock, undefined);
});

// ============================================================================
// M2. ProjectContext 接口字段完整性
// ============================================================================

test("M2. ProjectContext 接口字段完整性", () => {
  const ctx: ProjectContext = {
    projectRoot: "/tmp/proj",
    existingParadigm: "cqrs-es",
    existingDomainModelUri: "file:///tmp/proj/dm.md",
  };
  assert.equal(ctx.projectRoot, "/tmp/proj");
  assert.equal(ctx.existingParadigm, "cqrs-es");
  assert.equal(ctx.existingDomainModelUri, "file:///tmp/proj/dm.md");
});

// ============================================================================
// M3. UserStory / AcceptanceCriterion 接口字段完整性
// ============================================================================

test("M3. UserStory / AcceptanceCriterion 接口字段完整性", () => {
  const ac: AcceptanceCriterion = {
    id: "AC-001",
    given: "客户已登录",
    when: "提交订单",
    then: "订单状态为待支付",
  };
  const us: UserStory = {
    id: "US-001",
    role: "订单管理员",
    action: "创建订单",
    benefit: "跟踪订单状态",
    acceptanceCriteria: [ac],
    domainEventCandidates: ["OrderCreatedEvent"],
  };
  assert.equal(us.id, "US-001");
  assert.equal(us.role, "订单管理员");
  assert.equal(us.action, "创建订单");
  assert.equal(us.benefit, "跟踪订单状态");
  assert.equal(us.acceptanceCriteria.length, 1);
  assert.equal(us.acceptanceCriteria[0].id, "AC-001");
  assert.equal(us.acceptanceCriteria[0].given, "客户已登录");
  assert.equal(us.acceptanceCriteria[0].when, "提交订单");
  assert.equal(us.acceptanceCriteria[0].then, "订单状态为待支付");
  assert.equal(us.domainEventCandidates.length, 1);
  assert.equal(us.domainEventCandidates[0], "OrderCreatedEvent");
});

// ============================================================================
// M4. StructuredRequirement / DomainTerm / NonFunctionalRequirement 接口字段完整性
// ============================================================================

test("M4. StructuredRequirement / DomainTerm / NonFunctionalRequirement 接口字段完整性", () => {
  const term: DomainTerm = {
    term: "订单",
    definition: "客户提交的购买请求",
    synonyms: ["Order", "订单单据"],
  };
  const nfr: NonFunctionalRequirement = {
    id: "NFR-001",
    category: "consistency",
    description: "P99 延迟 < 200ms",
  };
  const req: StructuredRequirement = {
    userStories: [
      {
        id: "US-001",
        role: "用户",
        action: "登录",
        benefit: "访问个人中心",
        acceptanceCriteria: [],
        domainEventCandidates: [],
      },
    ],
    domainGlossary: [term],
    nonFunctionalRequirements: [nfr],
  };
  assert.equal(req.userStories.length, 1);
  assert.equal(req.domainGlossary[0].term, "订单");
  assert.equal(req.domainGlossary[0].synonyms.length, 2);
  assert.equal(req.nonFunctionalRequirements[0].category, "consistency");
});

// ============================================================================
// M5. ArchitectureDocument / BoundedContext / LayerDefinition 接口字段完整性
// ============================================================================

test("M5. ArchitectureDocument / BoundedContext / LayerDefinition 接口字段完整性", () => {
  const ctx: BoundedContext = {
    name: "订单上下文",
    responsibility: "处理订单生命周期",
    aggregates: ["OrderAggregate"],
  };
  const layer: LayerDefinition = {
    name: "domain",
    responsibility: "领域模型",
    allowedDependencies: [],
  };
  const arch: ArchitectureDocument = {
    selectedParadigmId: "ddd-layered",
    paradigmRationale: "业务复杂度高，DDD 适用",
    signalEvidence: { domainComplexity: "需求中含 5 个用户故事" },
    boundedContexts: [ctx],
    layering: [layer],
    dependencyRules: [],
  };
  assert.equal(arch.selectedParadigmId, "ddd-layered");
  assert.equal(arch.boundedContexts[0].name, "订单上下文");
  assert.equal(arch.layering[0].name, "domain");
  assert.equal(arch.signalEvidence.domainComplexity.length > 0, true);
});

// ============================================================================
// M6. DomainModelDocument 及其构件接口字段完整性
// ============================================================================

test("M6a. AggregateDefinition / EntityDefinition / AttributeDefinition / BehaviorDefinition 接口字段完整性", () => {
  const attr: AttributeDefinition = {
    name: "orderId",
    type: "OrderId",
    required: true,
  };
  const beh: BehaviorDefinition = {
    name: "confirm",
    description: "确认订单",
    publishedEvents: ["OrderConfirmedEvent"],
  };
  const ent: EntityDefinition = {
    name: "OrderEntity",
    aggregate: "OrderAggregate",
    attributes: [attr],
    behaviors: [beh],
  };
  const agg: AggregateDefinition = {
    name: "OrderAggregate",
    rootEntity: "OrderEntity",
    invariants: ["订单总金额必须等于所有订单项金额之和"],
    containedEntities: ["OrderLineEntity"],
    valueObjects: ["MoneyVO"],
    publishedEvents: ["OrderCreatedEvent", "OrderConfirmedEvent"],
  };
  assert.equal(agg.name, "OrderAggregate");
  assert.equal(agg.rootEntity, "OrderEntity");
  assert.equal(agg.invariants.length, 1);
  assert.equal(agg.publishedEvents.length, 2);
  assert.equal(ent.attributes[0].name, "orderId");
  assert.equal(ent.behaviors[0].publishedEvents[0], "OrderConfirmedEvent");
});

test("M6b. ValueObjectDefinition / DomainEventDefinition / DomainModelDocument 接口字段完整性", () => {
  const vo: ValueObjectDefinition = {
    name: "MoneyVO",
    attributes: [
      { name: "amount", type: "number", required: true },
      { name: "currency", type: "string", required: true },
    ],
    immutabilityGuarantee: "所有字段 readonly + 构造后无 setter",
  };
  const evt: DomainEventDefinition = {
    name: "OrderCreatedEvent",
    publisher: "OrderAggregate",
    subscribers: ["OrderProjection"],
    payload: [{ name: "orderId", type: "OrderId", required: true }],
  };
  const dm: DomainModelDocument = {
    aggregates: [],
    entities: [],
    valueObjects: [vo],
    domainEvents: [evt],
  };
  assert.equal(dm.valueObjects[0].name, "MoneyVO");
  assert.equal(dm.valueObjects[0].immutabilityGuarantee.length > 0, true);
  assert.equal(dm.domainEvents[0].publisher, "OrderAggregate");
  assert.equal(dm.domainEvents[0].subscribers[0], "OrderProjection");
});

// ============================================================================
// M7. DesignArtifacts / DesignEvaluationVerdict / DesignLoopResult 接口字段完整性
// ============================================================================

test("M7. DesignArtifacts / DesignEvaluationVerdict / DesignLoopResult 接口字段完整性", () => {
  const verdict: DesignEvaluationVerdict = {
    passed: true,
    reason: "全部判定项通过",
    severity: "warning",
    findings: [],
    suggestedFix: "",
  };
  const artifacts: DesignArtifacts = {
    structuredRequirement: {
      userStories: [],
      domainGlossary: [],
      nonFunctionalRequirements: [],
    },
    architectureDocument: {
      selectedParadigmId: "ddd-layered",
      paradigmRationale: "test",
      signalEvidence: {},
      boundedContexts: [],
      layering: [],
      dependencyRules: [],
    },
    domainModelDocument: {
      aggregates: [],
      entities: [],
      valueObjects: [],
      domainEvents: [],
    },
  };
  const result: DesignLoopResult = {
    input: { rawRequirement: "需求" },
    artifacts,
    evaluationVerdict: verdict,
    humanCheckpointTriggered: true,
    iterations: 1,
  };
  assert.equal(verdict.passed, true);
  assert.equal(verdict.severity, "warning");
  assert.equal(result.humanCheckpointTriggered, true);
  assert.equal(result.iterations, 1);
  assert.equal(result.artifacts.architectureDocument.selectedParadigmId, "ddd-layered");
});

// ============================================================================
// M8. DesignLoopConfig 接口字段完整性 + DEFAULT_DESIGN_LOOP_CONFIG 默认值
// ============================================================================

test("M8. DEFAULT_DESIGN_LOOP_CONFIG 默认值正确", () => {
  assert.equal(DEFAULT_DESIGN_LOOP_CONFIG.maxIterations, 3);
  assert.equal(DEFAULT_DESIGN_LOOP_CONFIG.triggerHumanCheckpoint, true);
  assert.equal(DEFAULT_DESIGN_LOOP_CONFIG.evaluationMode, "strict");
});

test("M8b. DEFAULT_DESIGN_LOOP_CONFIG 已冻结（Object.isFrozen）", () => {
  assert.equal(Object.isFrozen(DEFAULT_DESIGN_LOOP_CONFIG), true);
});

// ============================================================================
// M9. createDefaultDesignLoopConfig 工厂函数
// ============================================================================

test("M9a. createDefaultDesignLoopConfig() 无参数返回默认配置", () => {
  const cfg = createDefaultDesignLoopConfig();
  assert.equal(cfg.maxIterations, 3);
  assert.equal(cfg.triggerHumanCheckpoint, true);
  assert.equal(cfg.evaluationMode, "strict");
});

test("M9b. createDefaultDesignLoopConfig({ maxIterations: 5 }) 部分覆盖", () => {
  const cfg = createDefaultDesignLoopConfig({ maxIterations: 5 });
  assert.equal(cfg.maxIterations, 5);
  assert.equal(cfg.triggerHumanCheckpoint, true); // 未覆盖的字段保持默认
  assert.equal(cfg.evaluationMode, "strict");
});

test("M9c. createDefaultDesignLoopConfig 返回对象已冻结", () => {
  const cfg = createDefaultDesignLoopConfig();
  assert.equal(Object.isFrozen(cfg), true);
});

test("M9d. createDefaultDesignLoopConfig 非法 maxIterations=0 抛 DesignLoopConfigError", () => {
  assert.throws(
    () => createDefaultDesignLoopConfig({ maxIterations: 0 }),
    (err: unknown) => {
      assert.ok(err instanceof DesignLoopConfigError);
      assert.equal((err as DesignLoopConfigError).field, "maxIterations");
      return true;
    }
  );
});

test("M9d2. createDefaultDesignLoopConfig 非法 maxIterations=1.5（非整数）抛错", () => {
  assert.throws(
    () => createDefaultDesignLoopConfig({ maxIterations: 1.5 }),
    (err: unknown) => err instanceof DesignLoopConfigError
  );
});

test("M9d3. createDefaultDesignLoopConfig 非法 maxIterations=-1 抛错", () => {
  assert.throws(
    () => createDefaultDesignLoopConfig({ maxIterations: -1 }),
    (err: unknown) => err instanceof DesignLoopConfigError
  );
});

test("M9e. createDefaultDesignLoopConfig 非法 triggerHumanCheckpoint 抛错", () => {
  // @ts-expect-error 故意传入非 boolean 测试运行时校验
  assert.throws(
    () => createDefaultDesignLoopConfig({ triggerHumanCheckpoint: "yes" }),
    (err: unknown) => {
      assert.ok(err instanceof DesignLoopConfigError);
      assert.equal((err as DesignLoopConfigError).field, "triggerHumanCheckpoint");
      return true;
    }
  );
});

test("M9f. createDefaultDesignLoopConfig 非法 evaluationMode 抛错", () => {
  // @ts-expect-error 故意传入非法字面量测试运行时校验
  assert.throws(
    () => createDefaultDesignLoopConfig({ evaluationMode: "invalid" }),
    (err: unknown) => {
      assert.ok(err instanceof DesignLoopConfigError);
      assert.equal((err as DesignLoopConfigError).field, "evaluationMode");
      return true;
    }
  );
});

test("M9g. createDefaultDesignLoopConfig 合法 lenient 模式", () => {
  const cfg = createDefaultDesignLoopConfig({ evaluationMode: "lenient" });
  assert.equal(cfg.evaluationMode, "lenient");
});

test("M9h. DesignLoopConfigError 字段可读", () => {
  try {
    createDefaultDesignLoopConfig({ maxIterations: 0 });
    assert.fail("应抛错");
  } catch (err) {
    assert.ok(err instanceof DesignLoopConfigError);
    const e = err as DesignLoopConfigError;
    assert.equal(e.field, "maxIterations");
    assert.equal(e.value, 0);
    assert.ok(e.reason.includes(">= 1"));
    assert.equal(e.name, "DesignLoopConfigError");
    assert.ok(e.message.includes("maxIterations"));
  }
});

// ============================================================================
// M10. 不可变保证：readonly 字段在 TS 层禁止赋值（运行时通过 Object.freeze 保证）
// ============================================================================

test("M10. 工厂函数返回的配置对象在运行时不可变（Object.freeze 保证）", () => {
  const cfg: DesignLoopConfig = createDefaultDesignLoopConfig();
  // strict 模式下赋值会抛 TypeError；非 strict 模式静默失败
  // 由于 node:test 默认非 strict，这里用 try/catch 兼容两种模式
  let mutateThrew = false;
  try {
    // @ts-expect-error 故意修改 readonly 字段测试冻结
    cfg.maxIterations = 999;
  } catch {
    mutateThrew = true;
  }
  // 静默失败或抛错都算"不可变"通过
  assert.ok(mutateThrew || cfg.maxIterations === 3, "应抛错或保持原值");
});
