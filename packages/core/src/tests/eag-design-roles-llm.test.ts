/**
 * DESIGN Loop LLM 角色生产实现单元测试（EAG-P1 S3.2 接线批次）
 *
 * 测试范围（design-roles-llm.ts）：
 * - DesignRoleError：错误类型（role 标识 / message / name）
 * - LlmProductManager：构造校验 / 成功解析 / 客户端不可用 / 调用异常 /
 *   输出非法 JSON / markdown 代码块包裹 / 前后杂讯兜底提取 /
 *   userStories 空 / acceptanceCriteria 空 / NFR category 非法
 * - LlmArchitect：成功路径（dependencyRules 由范式注册表权威填充）/
 *   selectedParadigmId 非法 / 反馈注入 prompt（previousVerdict → 失败原因文本）
 * - FeedbackAwareArchitect：同 requirement 反馈注入 inner / 异 requirement 跨轮隔离
 * - FeedbackCapturingEvaluator：判定透传 + onVerdict 回调
 *
 * 测试约定（对齐 eag-dynamic-suggester.test.ts）：
 * - 使用 node:test + node:assert/strict
 * - 禁止 mock：LLMClient 使用真实 createMessage 签名桩（记录请求 + 返回固定 JSON 文本）
 * - 输入输出使用 Object.freeze 冻结（对齐不可变优先 §5.12.4 G-A6d）
 *
 * @module tests/eag-design-roles-llm
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DesignRoleError,
  LlmProductManager,
  LlmArchitect,
  FeedbackAwareArchitect,
  FeedbackCapturingEvaluator,
} from "../eag/design/design-roles-llm";
import type { LLMClient, LLMRequest, LLMResponse } from "../providers/llm-provider";
import type { DesignEvaluationVerdict, StructuredRequirement } from "../eag/design/design-models";

// ============================================================================
// 测试辅助（真实签名桩，非 mock）
// ============================================================================

/**
 * 构造记录请求并按回调返回内容的 LLMClient 桩
 *
 * @param respond 依据请求返回响应文本的回调（可依据 messages 断言 prompt 内容）
 * @returns client 桩与已记录的请求清单
 */
function createRecordingStubClient(respond: (request: LLMRequest) => string): {
  client: LLMClient;
  requests: LLMRequest[];
} {
  const requests: LLMRequest[] = [];
  const client: LLMClient = Object.freeze({
    providerName: "openai" as const,
    model: "test-model",
    baseURL: "https://test.example.com",
    supportsThinking: false,
    supportsPromptCaching: false,
    async createMessage(request: LLMRequest): Promise<LLMResponse> {
      requests.push(request);
      return Object.freeze({
        content: respond(request),
        thinking: "",
        toolCalls: [],
        stopReason: "stop",
        usage: Object.freeze({ inputTokens: 10, outputTokens: 20 }),
      });
    },
    async *createMessageStream(): AsyncIterable<never> {
      // 角色调用不使用流式，空实现
    },
  });
  return { client, requests };
}

/** 构造始终抛异常的 LLMClient 桩（模拟网络/凭据故障） */
function createThrowingStubClient(): LLMClient {
  return Object.freeze({
    providerName: "openai" as const,
    model: "test-model",
    baseURL: "https://test.example.com",
    supportsThinking: false,
    supportsPromptCaching: false,
    async createMessage(): Promise<LLMResponse> {
      throw new Error("网络连接超时");
    },
    async *createMessageStream(): AsyncIterable<never> {
      // 空实现
    },
  });
}

/** PM 角色的合法输出 JSON（最小完整样例：1 故事 + 1 词汇 + 1 NFR） */
const VALID_PM_JSON = `{
  "userStories": [
    {
      "id": "US-001",
      "role": "订单管理员",
      "action": "创建订单",
      "benefit": "跟踪订单状态",
      "acceptanceCriteria": [
        { "id": "AC-001", "given": "已登录且购物车非空", "when": "提交订单表单", "then": "订单创建成功并返回订单号" }
      ],
      "domainEventCandidates": ["OrderCreatedEvent"]
    }
  ],
  "domainGlossary": [
    { "term": "订单", "definition": "客户购买商品的凭证", "synonyms": ["order"] }
  ],
  "nonFunctionalRequirements": [
    { "id": "NFR-001", "category": "performance", "description": "创建订单接口 P95 响应时间小于 500ms" }
  ]
}`;

/** 架构师角色的合法输出 JSON（对齐 design-role-prompts.ts ARCHITECT_OUTPUT_SCHEMA_EXAMPLE） */
const VALID_ARCHITECT_JSON = `{
  "selectedParadigmId": "ddd-layered",
  "paradigmRationale": "业务实体关系丰富且要求强一致，DDD 分层最匹配",
  "signalEvidence": {
    "domainComplexity": "需求包含订单实体与状态转换，业务复杂度高",
    "consistencyRequirement": "需求要求订单状态强一致",
    "readWritePattern": "读写均衡，订单查询与创建均频繁",
    "integrationComplexity": "单体应用，无外部系统集成"
  },
  "boundedContexts": [
    { "name": "订单上下文", "responsibility": "承载订单创建/确认/支付的核心业务能力", "aggregates": ["OrderAggregate"] }
  ],
  "layering": [
    { "name": "domain", "responsibility": "领域模型，零外部依赖", "allowedDependencies": [] },
    { "name": "application", "responsibility": "应用编排", "allowedDependencies": ["domain"] }
  ],
  "domainModel": {
    "aggregates": [
      { "name": "OrderAggregate", "rootEntity": "OrderEntity", "invariants": ["订单总金额必须等于明细之和"], "containedEntities": ["OrderLineEntity"], "valueObjects": ["MoneyVO"], "publishedEvents": ["OrderCreatedEvent"] }
    ],
    "entities": [
      { "name": "OrderEntity", "aggregate": "OrderAggregate", "attributes": [{ "name": "orderId", "type": "string", "required": true }], "behaviors": [{ "name": "confirm", "description": "确认订单", "publishedEvents": ["OrderConfirmedEvent"] }] }
    ],
    "valueObjects": [
      { "name": "MoneyVO", "attributes": [{ "name": "amount", "type": "number", "required": true }], "immutabilityGuarantee": "所有字段 readonly + 构造后无 setter" }
    ],
    "domainEvents": [
      { "name": "OrderCreatedEvent", "publisher": "OrderAggregate", "subscribers": ["OrderProjection"], "payload": [{ "name": "orderId", "type": "string", "required": true }] }
    ]
  }
}`;

/** 最小合法 StructuredRequirement（架构师角色入参） */
const MINIMAL_REQUIREMENT: StructuredRequirement = Object.freeze({
  userStories: Object.freeze([
    Object.freeze({
      id: "US-001",
      role: "订单管理员",
      action: "创建订单",
      benefit: "跟踪订单状态",
      acceptanceCriteria: Object.freeze([
        Object.freeze({ id: "AC-001", given: "已登录", when: "提交订单表单", then: "订单创建成功" }),
      ]),
      domainEventCandidates: Object.freeze(["OrderCreatedEvent"]),
    }),
  ]),
  domainGlossary: Object.freeze([]),
  nonFunctionalRequirements: Object.freeze([]),
});

/** 构造评估判定（FeedbackAwareArchitect / FeedbackCapturingEvaluator 测试用） */
function createVerdict(passed: boolean): DesignEvaluationVerdict {
  return Object.freeze({
    passed,
    reason: passed ? "全部判定项通过" : "范式一致性判定失败：layering 未覆盖范式规定的层",
    findings: passed ? Object.freeze([]) : Object.freeze(["layering 层名集合与 ddd-layered 规定不一致"]),
    severity: passed ? "info" : "major",
    suggestedFix: passed ? "" : "按 ddd-layered 依赖规则补齐缺失层",
  });
}

// ============================================================================
// DesignRoleError
// ============================================================================

test("DesignRoleError 携带角色标识与中文错误信息", () => {
  const pmErr = new DesignRoleError("pm", "LLM 客户端不可用");
  assert.equal(pmErr.name, "DesignRoleError");
  assert.equal(pmErr.role, "pm");
  assert.ok(pmErr.message.includes("产品经理"), "错误信息应含角色中文名");
  assert.ok(pmErr.message.includes("LLM 客户端不可用"), "错误信息应含原始原因");

  const archErr = new DesignRoleError("architect", "输出非法");
  assert.equal(archErr.role, "architect");
  assert.ok(archErr.message.includes("架构师"), "错误信息应含角色中文名");
});

// ============================================================================
// LlmProductManager
// ============================================================================

test("LlmProductManager 构造函数要求 createLLMClient 为函数", () => {
  assert.throws(
    () => new LlmProductManager({ createLLMClient: undefined as unknown as () => LLMClient | null }),
    /createLLMClient 必须为函数/
  );
});

test("LlmProductManager 成功解析合法 JSON 输出为 StructuredRequirement", async () => {
  const { client, requests } = createRecordingStubClient(() => VALID_PM_JSON);
  const pm = new LlmProductManager({ createLLMClient: () => client });

  const requirement = await pm.structureRequirement("作为订单管理员，我希望创建订单，以便跟踪订单状态");

  // 字段逐项断言（结构化校验非透传：值来自解析结果）
  assert.equal(requirement.userStories.length, 1);
  assert.equal(requirement.userStories[0].id, "US-001");
  assert.equal(requirement.userStories[0].role, "订单管理员");
  assert.equal(requirement.userStories[0].acceptanceCriteria.length, 1);
  assert.equal(requirement.userStories[0].acceptanceCriteria[0].given, "已登录且购物车非空");
  assert.deepEqual(requirement.userStories[0].domainEventCandidates, ["OrderCreatedEvent"]);
  assert.equal(requirement.domainGlossary.length, 1);
  assert.equal(requirement.domainGlossary[0].term, "订单");
  assert.deepEqual(requirement.domainGlossary[0].synonyms, ["order"]);
  assert.equal(requirement.nonFunctionalRequirements.length, 1);
  assert.equal(requirement.nonFunctionalRequirements[0].category, "performance");

  // prompt 断言：system 含角色职责，user 含原始需求原文
  assert.equal(requests.length, 1);
  const messages = requests[0].messages as ReadonlyArray<{ role: string; content: string }>;
  assert.equal(messages[0].role, "system");
  assert.ok(messages[0].content.includes("产品经理"), "system prompt 应含 PM 角色定义");
  assert.ok(messages[1].content.includes("作为订单管理员"), "user prompt 应含原始需求原文");
});

test("LlmProductManager 客户端不可用（返回 null）时抛 DesignRoleError（fail-closed）", async () => {
  const pm = new LlmProductManager({ createLLMClient: () => null });
  await assert.rejects(
    pm.structureRequirement("任意需求"),
    (err: unknown) => err instanceof DesignRoleError && err.role === "pm" && err.message.includes("LLM 客户端不可用")
  );
});

test("LlmProductManager LLM 调用异常时抛 DesignRoleError（含原始原因）", async () => {
  const pm = new LlmProductManager({ createLLMClient: () => createThrowingStubClient() });
  await assert.rejects(
    pm.structureRequirement("任意需求"),
    (err: unknown) =>
      err instanceof DesignRoleError &&
      err.role === "pm" &&
      err.message.includes("LLM 调用失败") &&
      err.message.includes("网络连接超时")
  );
});

test("LlmProductManager 输出为空字符串时抛 DesignRoleError", async () => {
  const { client } = createRecordingStubClient(() => "   ");
  const pm = new LlmProductManager({ createLLMClient: () => client });
  await assert.rejects(
    pm.structureRequirement("任意需求"),
    (err: unknown) => err instanceof DesignRoleError && err.role === "pm" && err.message.includes("空字符串")
  );
});

test("LlmProductManager 输出非 JSON 时抛 DesignRoleError（含原始输出片段）", async () => {
  const { client } = createRecordingStubClient(() => "这不是一段 JSON 输出");
  const pm = new LlmProductManager({ createLLMClient: () => client });
  await assert.rejects(
    pm.structureRequirement("任意需求"),
    (err: unknown) => err instanceof DesignRoleError && err.role === "pm" && err.message.includes("不是合法 JSON")
  );
});

test("LlmProductManager 兼容 markdown 代码块包裹的 JSON 输出", async () => {
  const { client } = createRecordingStubClient(() => "```json\n" + VALID_PM_JSON + "\n```");
  const pm = new LlmProductManager({ createLLMClient: () => client });
  const requirement = await pm.structureRequirement("作为订单管理员，我希望创建订单");
  assert.equal(requirement.userStories[0].id, "US-001");
});

test("LlmProductManager 兼容前后夹杂解释文字的 JSON 输出（兜底提取）", async () => {
  const { client } = createRecordingStubClient(() => `好的，以下是结构化结果：\n${VALID_PM_JSON}\n以上就是全部内容。`);
  const pm = new LlmProductManager({ createLLMClient: () => client });
  const requirement = await pm.structureRequirement("作为订单管理员，我希望创建订单");
  assert.equal(requirement.userStories[0].id, "US-001");
});

test("LlmProductManager userStories 为空数组时抛错（字段路径可定位）", async () => {
  const emptyStories = JSON.stringify({ userStories: [], domainGlossary: [], nonFunctionalRequirements: [] });
  const { client } = createRecordingStubClient(() => emptyStories);
  const pm = new LlmProductManager({ createLLMClient: () => client });
  await assert.rejects(
    pm.structureRequirement("任意需求"),
    (err: unknown) => err instanceof DesignRoleError && err.message.includes("userStories")
  );
});

test("LlmProductManager acceptanceCriteria 为空数组时抛错", async () => {
  const noAc = JSON.stringify({
    userStories: [
      { id: "US-001", role: "r", action: "a", benefit: "b", acceptanceCriteria: [], domainEventCandidates: [] },
    ],
    domainGlossary: [],
    nonFunctionalRequirements: [],
  });
  const { client } = createRecordingStubClient(() => noAc);
  const pm = new LlmProductManager({ createLLMClient: () => client });
  await assert.rejects(
    pm.structureRequirement("任意需求"),
    (err: unknown) => err instanceof DesignRoleError && err.message.includes("acceptanceCriteria")
  );
});

test("LlmProductManager nonFunctionalRequirements category 非法时抛错", async () => {
  const badNfr = JSON.stringify({
    userStories: [
      {
        id: "US-001",
        role: "r",
        action: "a",
        benefit: "b",
        acceptanceCriteria: [{ id: "AC-001", given: "g", when: "w", then: "t" }],
        domainEventCandidates: [],
      },
    ],
    domainGlossary: [],
    nonFunctionalRequirements: [{ id: "NFR-001", category: "illegal-category", description: "非法分类" }],
  });
  const { client } = createRecordingStubClient(() => badNfr);
  const pm = new LlmProductManager({ createLLMClient: () => client });
  await assert.rejects(
    pm.structureRequirement("任意需求"),
    (err: unknown) =>
      err instanceof DesignRoleError &&
      err.message.includes("performance/security/availability/scalability/consistency")
  );
});

// ============================================================================
// LlmArchitect
// ============================================================================

test("LlmArchitect 构造函数要求 createLLMClient 为函数", () => {
  assert.throws(
    () => new LlmArchitect({ createLLMClient: "not-a-function" as unknown as () => LLMClient | null }),
    /createLLMClient 必须为函数/
  );
});

test("LlmArchitect 成功路径：dependencyRules 由范式注册表权威填充（非 LLM 产出）", async () => {
  const { client } = createRecordingStubClient(() => VALID_ARCHITECT_JSON);
  const architect = new LlmArchitect({ createLLMClient: () => client });

  const { architecture, domainModel } = await architect.designArchitecture(MINIMAL_REQUIREMENT);

  // 架构文档字段
  assert.equal(architecture.selectedParadigmId, "ddd-layered");
  assert.ok(architecture.paradigmRationale.includes("DDD"));
  assert.equal(architecture.boundedContexts.length, 1);
  assert.equal(architecture.boundedContexts[0].name, "订单上下文");
  assert.equal(architecture.layering.length, 2);

  // 关键断言：dependencyRules 非空且来自范式注册表（LLM 输出中不含该字段）
  assert.ok(architecture.dependencyRules.length > 0, "dependencyRules 应由范式注册表填充（非空）");
  for (const rule of architecture.dependencyRules) {
    assert.ok(typeof rule.id === "string" && rule.id.length > 0, "依赖规则应有 id");
    assert.ok(Array.isArray(rule.forbiddenToLayers), "依赖规则应有 forbiddenToLayers");
  }

  // 领域模型字段
  assert.equal(domainModel.aggregates.length, 1);
  assert.equal(domainModel.aggregates[0].name, "OrderAggregate");
  assert.equal(domainModel.entities.length, 1);
  assert.ok(domainModel.entities[0].behaviors.length > 0, "实体应有业务方法（贫血模型禁令底线）");
  assert.equal(domainModel.domainEvents.length, 1);
  assert.equal(domainModel.domainEvents[0].name, "OrderCreatedEvent");
});

test("LlmArchitect selectedParadigmId 非法时抛 DesignRoleError", async () => {
  const badParadigm = JSON.stringify({
    ...JSON.parse(VALID_ARCHITECT_JSON),
    selectedParadigmId: "nonexistent-paradigm",
  });
  const { client } = createRecordingStubClient(() => badParadigm);
  const architect = new LlmArchitect({ createLLMClient: () => client });
  await assert.rejects(
    architect.designArchitecture(MINIMAL_REQUIREMENT),
    (err: unknown) =>
      err instanceof DesignRoleError && err.role === "architect" && err.message.includes("selectedParadigmId")
  );
});

test("LlmArchitect boundedContexts 为空数组时抛错", async () => {
  const emptyBc = JSON.stringify({ ...JSON.parse(VALID_ARCHITECT_JSON), boundedContexts: [] });
  const { client } = createRecordingStubClient(() => emptyBc);
  const architect = new LlmArchitect({ createLLMClient: () => client });
  await assert.rejects(
    architect.designArchitecture(MINIMAL_REQUIREMENT),
    (err: unknown) => err instanceof DesignRoleError && err.message.includes("boundedContexts")
  );
});

test("LlmArchitect 携带 previousVerdict 时 prompt 注入失败原因与修复建议", async () => {
  const { client, requests } = createRecordingStubClient(() => VALID_ARCHITECT_JSON);
  const architect = new LlmArchitect({ createLLMClient: () => client });
  const verdict = createVerdict(false);

  await architect.designArchitecture(MINIMAL_REQUIREMENT, undefined, undefined, verdict);

  // prompt 断言：user 消息应包含反馈段（失败原因 / 问题清单 / 修复建议）
  assert.equal(requests.length, 1);
  const messages = requests[0].messages as ReadonlyArray<{ role: string; content: string }>;
  assert.ok(messages[1].content.includes("上一轮评估未通过"), "user prompt 应含反馈段标题");
  assert.ok(messages[1].content.includes(verdict.reason), "user prompt 应含失败原因");
  assert.ok(messages[1].content.includes(verdict.findings[0]), "user prompt 应含问题清单");
  assert.ok(messages[1].content.includes(verdict.suggestedFix), "user prompt 应含修复建议");
});

test("LlmArchitect 范式锁定时 prompt 强制采用锁定范式", async () => {
  const { client, requests } = createRecordingStubClient(() => VALID_ARCHITECT_JSON);
  const architect = new LlmArchitect({ createLLMClient: () => client });
  const paradigmLock = Object.freeze({ locked: true, paradigmId: "cqrs-es" as const, reason: "组织规范" });

  await architect.designArchitecture(MINIMAL_REQUIREMENT, paradigmLock);

  const messages = requests[0].messages as ReadonlyArray<{ role: string; content: string }>;
  assert.ok(messages[1].content.includes("范式锁定"), "锁定场景 user prompt 应含锁定提示");
  assert.ok(messages[1].content.includes("cqrs-es"), "锁定提示应含锁定范式 ID");
});

// ============================================================================
// FeedbackAwareArchitect
// ============================================================================

test("FeedbackAwareArchitect 对同一 requirement 的重试调用注入上轮判定反馈", async () => {
  const { client, requests } = createRecordingStubClient(() => VALID_ARCHITECT_JSON);
  const architect = new FeedbackAwareArchitect(new LlmArchitect({ createLLMClient: () => client }));

  // 第一次调用（未记录判定）：prompt 不含反馈段
  await architect.designArchitecture(MINIMAL_REQUIREMENT);
  let messages = requests[0].messages as ReadonlyArray<{ role: string; content: string }>;
  assert.ok(!messages[1].content.includes("上一轮评估未通过"), "首次调用不应含反馈段");

  // 记录失败判定后同 requirement 重试：prompt 应含反馈段（失败原因 + 修复建议）
  const verdict = createVerdict(false);
  architect.recordVerdict(MINIMAL_REQUIREMENT, verdict);
  await architect.designArchitecture(MINIMAL_REQUIREMENT);

  assert.equal(requests.length, 2, "应发生两次 LLM 调用");
  messages = requests[1].messages as ReadonlyArray<{ role: string; content: string }>;
  assert.ok(messages[1].content.includes("上一轮评估未通过"), "同 requirement 重试应注入反馈段");
  assert.ok(messages[1].content.includes(verdict.reason), "反馈段应含失败原因");
  assert.ok(messages[1].content.includes(verdict.suggestedFix), "反馈段应含修复建议");
});

test("FeedbackAwareArchitect 不同 requirement 的调用不注入旧反馈（跨轮隔离）", async () => {
  const { client, requests } = createRecordingStubClient(() => VALID_ARCHITECT_JSON);
  const architect = new FeedbackAwareArchitect(new LlmArchitect({ createLLMClient: () => client }));

  // 对 requirementA 记录失败判定
  architect.recordVerdict(MINIMAL_REQUIREMENT, createVerdict(false));

  // 以不同对象 requirementB 调用：旧反馈不应注入（引用不等 → lastFeedback 不匹配）
  const requirementB: StructuredRequirement = {
    ...MINIMAL_REQUIREMENT,
    userStories: [{ ...MINIMAL_REQUIREMENT.userStories[0], id: "US-999" }],
  };
  await architect.designArchitecture(requirementB);

  const messages = requests[0].messages as ReadonlyArray<{ role: string; content: string }>;
  assert.ok(!messages[1].content.includes("上一轮评估未通过"), "不同 requirement 的调用不应注入旧反馈（跨轮隔离）");
});

// ============================================================================
// FeedbackCapturingEvaluator
// ============================================================================

test("FeedbackCapturingEvaluator 透传内部判定并回调 onVerdict", async () => {
  const captured: Array<{ requirement: StructuredRequirement; verdict: DesignEvaluationVerdict }> = [];

  // 测试内固定判定评估器：真实实现 DesignEvaluatorProtocol 接口（非 mock），
  // 返回预设 verdict 并记录入参，用于验证包装器透传语义
  const fixedVerdict = createVerdict(false);
  const recordedInputs: unknown[] = [];
  const innerEvaluator = {
    async evaluate(artifacts: unknown, paradigm: unknown): Promise<DesignEvaluationVerdict> {
      recordedInputs.push({ artifacts, paradigm });
      return fixedVerdict;
    },
  };
  const evaluator = new FeedbackCapturingEvaluator(innerEvaluator, (requirement, verdict) => {
    captured.push({ requirement, verdict });
  });

  // 构造最小 artifacts / paradigm（评估逻辑本身已由 eag-design-evaluator.test.ts 覆盖）
  const artifacts = {
    structuredRequirement: MINIMAL_REQUIREMENT,
    architectureDocument: {},
    domainModelDocument: {},
  } as Parameters<typeof evaluator.evaluate>[0];
  const paradigm = { id: "ddd-layered" } as Parameters<typeof evaluator.evaluate>[1];

  const verdict = await evaluator.evaluate(artifacts, paradigm);

  // 透传断言：内部评估器收到原始入参；返回值与回调收到同一判定对象
  assert.equal(recordedInputs.length, 1, "内部评估器应被调用恰好一次");
  assert.equal((recordedInputs[0] as { artifacts: unknown }).artifacts, artifacts, "内部评估器应收到原始 artifacts");
  assert.equal(captured.length, 1, "onVerdict 应被回调恰好一次");
  assert.equal(captured[0].verdict, verdict, "回调判定应与返回判定为同一对象（透传不复制）");
  assert.equal(captured[0].verdict, fixedVerdict, "返回判定应为内部评估器的判定");
  assert.equal(captured[0].requirement, MINIMAL_REQUIREMENT, "回调 requirement 应为 artifacts 中的原对象");
});

test("FeedbackAwareArchitect + FeedbackCapturingEvaluator 组合构成反馈闭环", async () => {
  // 闭环语义端到端验证：evaluator 判定失败 → onVerdict 回调 recordVerdict →
  // 下一次同 requirement 设计调用的 prompt 携带失败反馈
  const { client, requests } = createRecordingStubClient(() => VALID_ARCHITECT_JSON);
  const feedbackArchitect = new FeedbackAwareArchitect(new LlmArchitect({ createLLMClient: () => client }));

  const failedVerdict = createVerdict(false);
  const evaluator = new FeedbackCapturingEvaluator(
    {
      async evaluate(): Promise<DesignEvaluationVerdict> {
        return failedVerdict;
      },
    },
    (requirement, verdict) => feedbackArchitect.recordVerdict(requirement, verdict)
  );

  // 构造最小 artifacts 触发评估 → 回调链 → 反馈记录
  const artifacts = {
    structuredRequirement: MINIMAL_REQUIREMENT,
    architectureDocument: {},
    domainModelDocument: {},
  } as Parameters<typeof evaluator.evaluate>[0];
  await evaluator.evaluate(artifacts, { id: "ddd-layered" } as Parameters<typeof evaluator.evaluate>[1]);

  // 重试设计调用：prompt 应含反馈（闭环生效）
  await feedbackArchitect.designArchitecture(MINIMAL_REQUIREMENT);
  const messages = requests[0].messages as ReadonlyArray<{ role: string; content: string }>;
  assert.ok(messages[1].content.includes("上一轮评估未通过"), "闭环后重试的设计调用应携带失败反馈");
  assert.ok(messages[1].content.includes(failedVerdict.reason), "反馈段应含评估失败原因");
});
