/**
 * EAG-P1 批次 3 单元测试：StaticDesignEvaluator 评估器
 *
 * 测试范围：
 * - E1. 范式一致性通过场景（dependencyRules 与 paradigm 一致 + layering 覆盖）
 * - E2. 范式一致性失败场景（selectedParadigmId 不一致）
 * - E3. 范式一致性失败场景（dependencyRules 缺失范式规则）
 * - E4. 范式一致性失败场景（layering 缺失范式依赖规则涉及的层）
 * - E5. 设计完整性通过场景（每个 UserStory 有聚合承载）
 * - E6. 设计完整性失败场景（UserStory 候选事件未在 domainEvents 定义）
 * - E7. 设计完整性失败场景（候选事件 publisher 不在聚合清单）
 * - E8. 设计完整性警告场景（UserStory.domainEventCandidates 为空）
 * - E9. 反模式零命中通过场景
 * - E10. 反模式命中场景（domain 依赖 infrastructure，命中 AP-DOM-ORM-01）
 * - E11. 反模式命中场景（application 含 Repository 关键词，命中 AP-REPO-DOM-01）
 * - E12. signalEvidence 证据强制通过场景（非锁定 + 证据非空）
 * - E13. signalEvidence 证据强制失败场景（非锁定 + 证据为空）
 * - E14. signalEvidence 证据强制跳过场景（锁定场景）
 * - E15. strict 模式：任一 finding 即不通过
 * - E16. lenient 模式：仅 blocker 级 finding 不通过
 * - E17. 完整通过场景（4 项判定全通过）
 *
 * 测试约定（严格遵循项目"禁止 mock"规则）：
 * - 使用 node:test + node:assert/strict
 * - 使用真实范式常量（DDD_LAYERED_PARADIGM 等），不使用任何 mock 框架
 * - 测试用例独立构造 artifacts，无共享可变状态
 *
 * 设计依据：
 * - EAG 方案 §5.2.2 评估器判定（范式一致性 + 设计完整性 + 反模式零命中 + 证据强制）
 * - eag/design/design-evaluator.ts 源文件
 *
 * @module core/tests/eag-design-evaluator
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { StaticDesignEvaluator } from "../eag/design/design-evaluator";
import { DDD_LAYERED_PARADIGM } from "../eag/eak/paradigms/ddd-layered";
import type { ArchitectureParadigm } from "../eag/eak/types";
import type { DesignArtifacts } from "../eag/design/design-models";

// ============================================================================
// 测试辅助：构造通过型 DesignArtifacts
// ============================================================================

/**
 * 构造一个能通过 StaticDesignEvaluator 全部 4 项判定的 DesignArtifacts
 *
 * 用于作为各判定项失败测试的"基线"，只需修改其中一部分即可触发特定失败。
 *
 * @param overrides 部分覆盖字段
 * @returns 通过型 DesignArtifacts
 */
function buildPassingArtifacts(overrides?: Partial<DesignArtifacts>): DesignArtifacts {
  const baseArtifacts: DesignArtifacts = {
    structuredRequirement: {
      userStories: [
        {
          id: "US-001",
          role: "订单管理员",
          action: "创建订单",
          benefit: "跟踪订单状态",
          acceptanceCriteria: [
            {
              id: "AC-001",
              given: "客户已登录",
              when: "提交订单",
              then: "订单状态为待支付",
            },
          ],
          domainEventCandidates: ["OrderCreatedEvent"],
        },
      ],
      domainGlossary: [
        {
          term: "订单",
          definition: "客户提交的购买请求",
          synonyms: ["Order"],
        },
      ],
      nonFunctionalRequirements: [],
    },
    architectureDocument: {
      selectedParadigmId: "ddd-layered",
      paradigmRationale: "业务复杂度高，DDD 分层适用",
      signalEvidence: {
        domainComplexity: "需求中包含订单生命周期管理，业务复杂度高",
        consistencyRequirement: "订单状态需强一致",
        readWritePattern: "读写均衡",
        integrationComplexity: "单体应用",
      },
      boundedContexts: [
        {
          name: "订单上下文",
          responsibility: "处理订单生命周期",
          aggregates: ["OrderAggregate"],
        },
      ],
      layering: [
        {
          name: "domain",
          responsibility: "领域模型，承载聚合根/实体/值对象/领域事件",
          allowedDependencies: [],
        },
        {
          name: "application",
          responsibility: "应用编排，事务边界，事件发布",
          allowedDependencies: ["domain"],
        },
        {
          name: "interfaces",
          responsibility: "接口适配，HTTP/gRPC 转换",
          allowedDependencies: ["application", "domain"],
        },
        {
          name: "infrastructure",
          responsibility: "基础设施，仓储实现/消息队列/配置",
          allowedDependencies: ["domain", "application"],
        },
      ],
      // 直接引用 DDD 范式的 dependencyRules，保证一致性
      dependencyRules: DDD_LAYERED_PARADIGM.dependencyRules,
    },
    domainModelDocument: {
      aggregates: [
        {
          name: "OrderAggregate",
          rootEntity: "OrderEntity",
          invariants: ["订单总金额必须等于所有订单项金额之和"],
          containedEntities: ["OrderLineEntity"],
          valueObjects: ["MoneyVO"],
          publishedEvents: ["OrderCreatedEvent"],
        },
      ],
      entities: [
        {
          name: "OrderEntity",
          aggregate: "OrderAggregate",
          attributes: [
            { name: "orderId", type: "OrderId", required: true },
            { name: "status", type: "OrderStatus", required: true },
          ],
          behaviors: [
            {
              name: "confirm",
              description: "确认订单",
              publishedEvents: ["OrderConfirmedEvent"],
            },
          ],
        },
      ],
      valueObjects: [
        {
          name: "MoneyVO",
          attributes: [
            { name: "amount", type: "number", required: true },
            { name: "currency", type: "string", required: true },
          ],
          immutabilityGuarantee: "所有字段 readonly + 构造后无 setter",
        },
      ],
      domainEvents: [
        {
          name: "OrderCreatedEvent",
          publisher: "OrderAggregate",
          subscribers: ["OrderProjection"],
          payload: [{ name: "orderId", type: "OrderId", required: true }],
        },
      ],
    },
  };
  return { ...baseArtifacts, ...overrides };
}

// ============================================================================
// E1. 范式一致性通过场景
// ============================================================================

test("E1. 范式一致性通过场景——dependencyRules 与 paradigm 一致 + layering 覆盖", async () => {
  const artifacts = buildPassingArtifacts();
  const evaluator = new StaticDesignEvaluator("strict", false);
  const verdict = await evaluator.evaluate(artifacts, DDD_LAYERED_PARADIGM);
  assert.equal(verdict.passed, true, `应通过，但 findings: ${verdict.findings.join("; ")}`);
  assert.equal(verdict.findings.length, 0);
});

// ============================================================================
// E2. 范式一致性失败场景：selectedParadigmId 不一致
// ============================================================================

test("E2. 范式一致性失败——selectedParadigmId 与评估器入参 paradigm.id 不一致", async () => {
  const artifacts = buildPassingArtifacts({
    architectureDocument: {
      ...buildPassingArtifacts().architectureDocument,
      selectedParadigmId: "clean-architecture", // 故意不一致
    },
  });
  const evaluator = new StaticDesignEvaluator("strict", false);
  const verdict = await evaluator.evaluate(artifacts, DDD_LAYERED_PARADIGM);
  assert.equal(verdict.passed, false);
  assert.ok(verdict.findings.some((f) => f.includes("selectedParadigmId") && f.includes("不一致")));
  assert.equal(verdict.severity, "blocker");
});

// ============================================================================
// E3. 范式一致性失败场景：dependencyRules 缺失范式规则
// ============================================================================

test("E3. 范式一致性失败——dependencyRules 缺失范式定义的规则", async () => {
  const baseArtifacts = buildPassingArtifacts();
  // 仅保留前 2 条规则，缺失后 3 条
  const incompleteRules = DDD_LAYERED_PARADIGM.dependencyRules.slice(0, 2);
  const artifacts = buildPassingArtifacts({
    architectureDocument: {
      ...baseArtifacts.architectureDocument,
      dependencyRules: incompleteRules,
    },
  });
  const evaluator = new StaticDesignEvaluator("strict", false);
  const verdict = await evaluator.evaluate(artifacts, DDD_LAYERED_PARADIGM);
  assert.equal(verdict.passed, false);
  assert.ok(verdict.findings.some((f) => f.includes("缺失范式定义的规则")));
});

// ============================================================================
// E4. 范式一致性失败场景：layering 缺失范式依赖规则涉及的层
// ============================================================================

test("E4. 范式一致性失败——layering 缺失范式依赖规则涉及的层", async () => {
  const baseArtifacts = buildPassingArtifacts();
  // 仅保留 domain 与 application 层，缺失 interfaces 与 infrastructure
  const incompleteLayering = baseArtifacts.architectureDocument.layering.slice(0, 2);
  const artifacts = buildPassingArtifacts({
    architectureDocument: {
      ...baseArtifacts.architectureDocument,
      layering: incompleteLayering,
    },
  });
  const evaluator = new StaticDesignEvaluator("strict", false);
  const verdict = await evaluator.evaluate(artifacts, DDD_LAYERED_PARADIGM);
  assert.equal(verdict.passed, false);
  assert.ok(verdict.findings.some((f) => f.includes("缺失范式依赖规则涉及的层")));
});

// ============================================================================
// E5. 设计完整性通过场景
// ============================================================================

test("E5. 设计完整性通过——每个 UserStory 的候选事件有聚合承载", async () => {
  const artifacts = buildPassingArtifacts();
  const evaluator = new StaticDesignEvaluator("strict", false);
  const verdict = await evaluator.evaluate(artifacts, DDD_LAYERED_PARADIGM);
  assert.equal(verdict.passed, true);
  // 不应有设计完整性相关的 finding
  assert.ok(!verdict.findings.some((f) => f.includes("设计完整性")));
});

// ============================================================================
// E6. 设计完整性失败场景：UserStory 候选事件未在 domainEvents 定义
// ============================================================================

test("E6. 设计完整性失败——候选事件未在 domainEvents 定义", async () => {
  const baseArtifacts = buildPassingArtifacts();
  // 修改 UserStory 的候选事件为不存在的事件
  const artifacts = buildPassingArtifacts({
    structuredRequirement: {
      ...baseArtifacts.structuredRequirement,
      userStories: [
        {
          ...baseArtifacts.structuredRequirement.userStories[0],
          domainEventCandidates: ["NonExistentEvent"],
        },
      ],
    },
  });
  const evaluator = new StaticDesignEvaluator("strict", false);
  const verdict = await evaluator.evaluate(artifacts, DDD_LAYERED_PARADIGM);
  assert.equal(verdict.passed, false);
  assert.ok(
    verdict.findings.some((f) => f.includes("NonExistentEvent") && f.includes("未在 domainModelDocument.domainEvents"))
  );
});

// ============================================================================
// E7. 设计完整性失败场景：候选事件 publisher 不在聚合清单
// ============================================================================

test("E7. 设计完整性失败——候选事件 publisher 不在聚合清单", async () => {
  const baseArtifacts = buildPassingArtifacts();
  // 修改事件的 publisher 为不存在的聚合
  const artifacts = buildPassingArtifacts({
    domainModelDocument: {
      ...baseArtifacts.domainModelDocument,
      domainEvents: [
        {
          ...baseArtifacts.domainModelDocument.domainEvents[0],
          publisher: "NonExistentAggregate",
        },
      ],
    },
  });
  const evaluator = new StaticDesignEvaluator("strict", false);
  const verdict = await evaluator.evaluate(artifacts, DDD_LAYERED_PARADIGM);
  assert.equal(verdict.passed, false);
  assert.ok(verdict.findings.some((f) => f.includes("NonExistentAggregate") && f.includes("不在聚合清单")));
});

// ============================================================================
// E8. 设计完整性警告场景：UserStory.domainEventCandidates 为空
// ============================================================================

test("E8. 设计完整性警告——UserStory.domainEventCandidates 为空", async () => {
  const baseArtifacts = buildPassingArtifacts();
  const artifacts = buildPassingArtifacts({
    structuredRequirement: {
      ...baseArtifacts.structuredRequirement,
      userStories: [
        {
          ...baseArtifacts.structuredRequirement.userStories[0],
          domainEventCandidates: [],
        },
      ],
    },
  });
  const evaluator = new StaticDesignEvaluator("strict", false);
  const verdict = await evaluator.evaluate(artifacts, DDD_LAYERED_PARADIGM);
  // strict 模式下 warning 也会失败
  assert.equal(verdict.passed, false);
  assert.ok(verdict.findings.some((f) => f.includes("未声明 domainEventCandidates")));
});

// ============================================================================
// E9. 反模式零命中通过场景
// ============================================================================

test("E9. 反模式零命中通过场景——layering 与 boundedContexts 未触发任何静态反模式", async () => {
  const artifacts = buildPassingArtifacts();
  const evaluator = new StaticDesignEvaluator("strict", false);
  const verdict = await evaluator.evaluate(artifacts, DDD_LAYERED_PARADIGM);
  assert.equal(verdict.passed, true);
  assert.ok(!verdict.findings.some((f) => f.includes("AP-")));
});

// ============================================================================
// E10. 反模式命中场景：domain 依赖 infrastructure（命中 AP-DOM-ORM-01）
// ============================================================================

test("E10. 反模式命中——domain 层 allowedDependencies 包含 infrastructure（AP-DOM-ORM-01）", async () => {
  const baseArtifacts = buildPassingArtifacts();
  // 修改 domain 层 allowedDependencies 包含 infrastructure
  const artifacts = buildPassingArtifacts({
    architectureDocument: {
      ...baseArtifacts.architectureDocument,
      layering: [
        {
          name: "domain",
          responsibility: "领域模型",
          allowedDependencies: ["infrastructure"], // 故意违反
        },
        ...baseArtifacts.architectureDocument.layering.slice(1),
      ],
    },
  });
  const evaluator = new StaticDesignEvaluator("strict", false);
  const verdict = await evaluator.evaluate(artifacts, DDD_LAYERED_PARADIGM);
  assert.equal(verdict.passed, false);
  assert.ok(verdict.findings.some((f) => f.includes("AP-DOM-ORM-01")));
  assert.equal(verdict.severity, "blocker");
});

// ============================================================================
// E11. 反模式命中场景：application 含 Repository 关键词（命中 AP-REPO-DOM-01）
// ============================================================================

test("E11. 反模式命中——application 层 responsibility 包含 Repository（AP-REPO-DOM-01）", async () => {
  const baseArtifacts = buildPassingArtifacts();
  const artifacts = buildPassingArtifacts({
    architectureDocument: {
      ...baseArtifacts.architectureDocument,
      layering: baseArtifacts.architectureDocument.layering.map((l) =>
        l.name === "application" ? { ...l, responsibility: "应用编排与 Repository 仓储接口定义" } : l
      ),
    },
  });
  const evaluator = new StaticDesignEvaluator("strict", false);
  const verdict = await evaluator.evaluate(artifacts, DDD_LAYERED_PARADIGM);
  assert.equal(verdict.passed, false);
  assert.ok(verdict.findings.some((f) => f.includes("AP-REPO-DOM-01")));
});

// ============================================================================
// E12. signalEvidence 证据强制通过场景（非锁定 + 证据非空）
// ============================================================================

test("E12. signalEvidence 证据强制通过——非锁定 + 证据非空", async () => {
  const artifacts = buildPassingArtifacts();
  const evaluator = new StaticDesignEvaluator("strict", false);
  const verdict = await evaluator.evaluate(artifacts, DDD_LAYERED_PARADIGM);
  assert.equal(verdict.passed, true);
  assert.ok(!verdict.findings.some((f) => f.includes("signalEvidence 证据强制失败")));
});

// ============================================================================
// E13. signalEvidence 证据强制失败场景（非锁定 + 证据为空）
// ============================================================================

test("E13. signalEvidence 证据强制失败——非锁定 + signalEvidence 为空", async () => {
  const baseArtifacts = buildPassingArtifacts();
  const artifacts = buildPassingArtifacts({
    architectureDocument: {
      ...baseArtifacts.architectureDocument,
      signalEvidence: {},
    },
  });
  const evaluator = new StaticDesignEvaluator("strict", false);
  const verdict = await evaluator.evaluate(artifacts, DDD_LAYERED_PARADIGM);
  assert.equal(verdict.passed, false);
  assert.ok(verdict.findings.some((f) => f.includes("signalEvidence 证据强制失败")));
  assert.equal(verdict.severity, "blocker");
});

test("E13b. signalEvidence 证据强制失败——证据值为空字符串", async () => {
  const baseArtifacts = buildPassingArtifacts();
  const artifacts = buildPassingArtifacts({
    architectureDocument: {
      ...baseArtifacts.architectureDocument,
      signalEvidence: { domainComplexity: "  " }, // 空白字符串
    },
  });
  const evaluator = new StaticDesignEvaluator("strict", false);
  const verdict = await evaluator.evaluate(artifacts, DDD_LAYERED_PARADIGM);
  assert.equal(verdict.passed, false);
  assert.ok(verdict.findings.some((f) => f.includes("domainComplexity") && f.includes("空字符串")));
});

// ============================================================================
// E14. signalEvidence 证据强制跳过场景（锁定场景）
// ============================================================================

test("E14. signalEvidence 证据强制跳过——锁定场景即使证据为空也通过", async () => {
  const baseArtifacts = buildPassingArtifacts();
  const artifacts = buildPassingArtifacts({
    architectureDocument: {
      ...baseArtifacts.architectureDocument,
      signalEvidence: {}, // 证据为空
    },
  });
  // paradigmLocked=true 跳过证据强制判定
  const evaluator = new StaticDesignEvaluator("strict", true);
  const verdict = await evaluator.evaluate(artifacts, DDD_LAYERED_PARADIGM);
  assert.equal(verdict.passed, true, `锁定场景应跳过证据判定，但 findings: ${verdict.findings.join("; ")}`);
});

// ============================================================================
// E15. strict 模式：任一 finding 即不通过
// ============================================================================

test("E15. strict 模式——warning 级 finding 也不通过", async () => {
  const baseArtifacts = buildPassingArtifacts();
  // 触发 warning：UserStory.domainEventCandidates 为空（warning 级）
  const artifacts = buildPassingArtifacts({
    structuredRequirement: {
      ...baseArtifacts.structuredRequirement,
      userStories: [
        {
          ...baseArtifacts.structuredRequirement.userStories[0],
          domainEventCandidates: [],
        },
      ],
    },
  });
  const evaluator = new StaticDesignEvaluator("strict", false);
  const verdict = await evaluator.evaluate(artifacts, DDD_LAYERED_PARADIGM);
  assert.equal(verdict.passed, false, "strict 模式下 warning 应导致不通过");
});

// ============================================================================
// E16. lenient 模式：仅 blocker 级 finding 不通过
// ============================================================================

test("E16a. lenient 模式——warning 级 finding 仍通过", async () => {
  const baseArtifacts = buildPassingArtifacts();
  // 触发 warning：UserStory.domainEventCandidates 为空
  const artifacts = buildPassingArtifacts({
    structuredRequirement: {
      ...baseArtifacts.structuredRequirement,
      userStories: [
        {
          ...baseArtifacts.structuredRequirement.userStories[0],
          domainEventCandidates: [],
        },
      ],
    },
  });
  const evaluator = new StaticDesignEvaluator("lenient", false);
  const verdict = await evaluator.evaluate(artifacts, DDD_LAYERED_PARADIGM);
  assert.equal(verdict.passed, true, "lenient 模式下 warning 不应导致不通过");
  // 但 findings 应记录 warning
  assert.ok(verdict.findings.some((f) => f.includes("未声明 domainEventCandidates")));
});

test("E16b. lenient 模式——blocker 级 finding 仍不通过", async () => {
  const baseArtifacts = buildPassingArtifacts();
  // 触发 blocker：selectedParadigmId 不一致
  const artifacts = buildPassingArtifacts({
    architectureDocument: {
      ...baseArtifacts.architectureDocument,
      selectedParadigmId: "clean-architecture",
    },
  });
  const evaluator = new StaticDesignEvaluator("lenient", false);
  const verdict = await evaluator.evaluate(artifacts, DDD_LAYERED_PARADIGM);
  assert.equal(verdict.passed, false, "lenient 模式下 blocker 仍应导致不通过");
  assert.equal(verdict.severity, "blocker");
});

// ============================================================================
// E17. 完整通过场景（4 项判定全通过）
// ============================================================================

test("E17. 完整通过场景——4 项判定全通过，findings 为空", async () => {
  const artifacts = buildPassingArtifacts();
  const evaluator = new StaticDesignEvaluator("strict", false);
  const verdict = await evaluator.evaluate(artifacts, DDD_LAYERED_PARADIGM);
  assert.equal(verdict.passed, true);
  assert.equal(verdict.findings.length, 0);
  assert.equal(verdict.severity, "warning"); // 无 finding 时默认 warning
  assert.ok(verdict.reason.includes("全部通过"));
  assert.equal(verdict.suggestedFix, "");
});

// ============================================================================
// E18. 多范式适配：Clean Architecture 范式反模式命中
// ============================================================================

test("E18. Clean Architecture 范式——entities 层依赖 frameworks 命中 AP-ENT-FRAMEWORK-01", async () => {
  // 使用 Clean Architecture 范式
  const { CLEAN_ARCHITECTURE_PARADIGM } = await import("../eag/eak/paradigms/clean-architecture");
  const baseArtifacts = buildPassingArtifacts();
  // 构造 Clean Architecture 风格的 artifacts，但 entities 层依赖 frameworks
  const artifacts: DesignArtifacts = {
    ...baseArtifacts,
    architectureDocument: {
      selectedParadigmId: "clean-architecture",
      paradigmRationale: "Clean Architecture 适用",
      signalEvidence: { domainComplexity: "中等复杂度" },
      boundedContexts: [],
      layering: [
        { name: "entities", responsibility: "实体层", allowedDependencies: ["frameworks"] }, // 故意违反
        { name: "use-cases", responsibility: "用例层", allowedDependencies: ["entities"] },
        { name: "adapters", responsibility: "适配器层", allowedDependencies: ["use-cases", "entities"] },
        { name: "frameworks", responsibility: "框架层", allowedDependencies: ["adapters", "use-cases", "entities"] },
      ],
      dependencyRules: CLEAN_ARCHITECTURE_PARADIGM.dependencyRules,
    },
  };
  const evaluator = new StaticDesignEvaluator("strict", false);
  const verdict = await evaluator.evaluate(artifacts, CLEAN_ARCHITECTURE_PARADIGM as ArchitectureParadigm);
  assert.equal(verdict.passed, false);
  assert.ok(verdict.findings.some((f) => f.includes("AP-ENT-FRAMEWORK-01")));
});
