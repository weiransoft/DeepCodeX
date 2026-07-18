/**
 * EAG-P1 批次 3 单元测试：文档章节结构、渲染器、校验器
 *
 * 测试范围：
 * - A1. ARCHITECTURE_MD_SECTIONS 章节结构与不可变性
 * - A2. DOMAIN_MODEL_MD_SECTIONS 章节结构与不可变性
 * - A3. renderArchitectureMd 渲染：完整文档含全部 5 个章节
 * - A4. renderArchitectureMd 渲染：空文档（boundedContexts/layering/dependencyRules 为空）
 * - A5. renderArchitectureMd 渲染：包含范式 ID + 选择理由 + 信号证据
 * - A6. renderArchitectureMd 渲染：包含限界上下文与聚合清单
 * - A7. renderArchitectureMd 渲染：包含分层定义与允许依赖
 * - A8. renderArchitectureMd 渲染：包含依赖规则（severity/fromLayer/forbiddenToLayers）
 * - A9. renderArchitectureMd 渲染：技术选型章节为 ETSB 占位
 * - A10. renderDomainModelMd 渲染：完整文档含全部 4 个章节
 * - A11. renderDomainModelMd 渲染：空文档（所有清单为空）
 * - A12. renderDomainModelMd 渲染：包含聚合清单（含不变式/内部实体/值对象/发布事件）
 * - A13. renderDomainModelMd 渲染：包含实体清单（含属性 + 行为 + 触发事件）
 * - A14. renderDomainModelMd 渲染：包含值对象清单（含不可变性保证）
 * - A15. renderDomainModelMd 渲染：包含领域事件清单（含发布者/订阅者/负载）
 * - A16. renderDomainModelMd 渲染：实体无行为时提示贫血模型
 * - A17. validateArchitectureMd：完整 markdown 通过校验
 * - A18. validateArchitectureMd：缺失章节时返回 missingSections
 * - A19. validateDomainModelMd：完整 markdown 通过校验
 * - A20. validateDomainModelMd：缺失章节时返回 missingSections
 * - A21. 端到端：渲染后立即校验应通过（render → validate 往返一致性）
 *
 * 测试约定（严格遵循项目"禁止 mock"规则）：
 * - 使用 node:test + node:assert/strict
 * - 直接构造真实的 ArchitectureDocument / DomainModelDocument 对象，不使用任何 mock 框架
 * - 渲染器与校验器为纯函数，测试用例独立、可重复
 *
 * 设计依据：
 * - EAG 方案 §5.2.2 产出物 ARCHITECTURE.md + DOMAIN-MODEL.md 章节模板
 * - eag/design/design-artifacts-schema.ts 源文件
 *
 * @module core/tests/eag-design-artifacts-schema
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ARCHITECTURE_MD_SECTIONS,
  DOMAIN_MODEL_MD_SECTIONS,
  renderArchitectureMd,
  renderDomainModelMd,
  validateArchitectureMd,
  validateDomainModelMd,
} from "../eag/design/design-artifacts-schema";
import { DDD_LAYERED_PARADIGM } from "../eag/eak/paradigms/ddd-layered";
import type { ArchitectureDocument, DomainModelDocument } from "../eag/design/design-models";

// ============================================================================
// 测试辅助：构造真实的 ArchitectureDocument / DomainModelDocument
// ============================================================================

/**
 * 构造一个完整的 ArchitectureDocument 用于渲染测试
 *
 * 包含范式选择理由、信号证据、1 个限界上下文（含聚合）、4 层分层、5 条依赖规则。
 * 直接引用 DDD_LAYERED_PARADIGM.dependencyRules 保证范式一致性。
 *
 * @returns 完整的 ArchitectureDocument 对象
 */
function buildFullArchitectureDocument(): ArchitectureDocument {
  return {
    selectedParadigmId: "ddd-layered",
    paradigmRationale: "业务复杂度高且需强一致，DDD 分层架构最匹配。",
    signalEvidence: {
      domainComplexity: "需求原文：订单生命周期含创建/支付/发货/收货多个状态。",
      consistencyRequirement: "需求原文：订单状态必须强一致，不允许中间状态。",
      readWritePattern: "需求原文：读写均衡，订单查询与创建均频繁。",
      integrationComplexity: "需求原文：当前为单体应用，无外部系统集成。",
    },
    boundedContexts: [
      {
        name: "订单上下文",
        responsibility: "处理订单生命周期：创建、支付、发货、收货、取消。",
        aggregates: ["OrderAggregate", "PaymentAggregate"],
      },
    ],
    layering: [
      {
        name: "domain",
        responsibility: "领域模型，承载聚合根/实体/值对象/领域事件，零外部依赖。",
        allowedDependencies: [],
      },
      {
        name: "application",
        responsibility: "应用编排，事务边界，事件发布。",
        allowedDependencies: ["domain"],
      },
      {
        name: "interfaces",
        responsibility: "接口适配，HTTP/gRPC 请求响应转换。",
        allowedDependencies: ["application", "domain"],
      },
      {
        name: "infrastructure",
        responsibility: "基础设施，仓储实现/消息队列/配置。",
        allowedDependencies: ["domain", "application"],
      },
    ],
    // 直接引用 DDD 范式的 dependencyRules，保证一致性
    dependencyRules: DDD_LAYERED_PARADIGM.dependencyRules,
  };
}

/**
 * 构造一个完整的 DomainModelDocument 用于渲染测试
 *
 * 包含 1 个聚合、1 个实体、1 个值对象、1 个领域事件，
 * 实体含 1 个属性与 1 个行为（行为触发领域事件）。
 *
 * @returns 完整的 DomainModelDocument 对象
 */
function buildFullDomainModelDocument(): DomainModelDocument {
  return {
    aggregates: [
      {
        name: "OrderAggregate",
        rootEntity: "OrderEntity",
        invariants: ["订单总金额必须等于所有订单项金额之和。", "订单状态只能按状态机推进。"],
        containedEntities: ["OrderLineEntity"],
        valueObjects: ["MoneyVO", "AddressVO"],
        publishedEvents: ["OrderCreatedEvent", "OrderConfirmedEvent"],
      },
    ],
    entities: [
      {
        name: "OrderEntity",
        aggregate: "OrderAggregate",
        attributes: [
          { name: "orderId", type: "OrderId", required: true },
          { name: "status", type: "OrderStatus", required: true },
          { name: "totalAmount", type: "MoneyVO", required: true },
        ],
        behaviors: [
          {
            name: "confirm",
            description: "确认订单，状态由 PENDING 推进到 CONFIRMED。",
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
        immutabilityGuarantee: "所有字段 readonly + 构造后无 setter + Object.freeze 冻结。",
      },
    ],
    domainEvents: [
      {
        name: "OrderCreatedEvent",
        publisher: "OrderAggregate",
        subscribers: ["OrderProjection", "InventorySaga"],
        payload: [
          { name: "orderId", type: "OrderId", required: true },
          { name: "createdAt", type: "Date", required: true },
        ],
      },
    ],
  };
}

// ============================================================================
// A1. ARCHITECTURE_MD_SECTIONS 章节结构与不可变性
// ============================================================================

test("A1. ARCHITECTURE_MD_SECTIONS 包含 5 个章节且冻结", () => {
  // 章节数应为 5（范式选择/限界上下文/分层架构/依赖规则/技术选型）
  assert.equal(ARCHITECTURE_MD_SECTIONS.length, 5);
  // 章节顺序与内容对齐 EAG 方案 §5.2.2 ARCHITECTURE.md 模板
  assert.equal(ARCHITECTURE_MD_SECTIONS[0], "1. 范式选择");
  assert.equal(ARCHITECTURE_MD_SECTIONS[1], "2. 限界上下文");
  assert.equal(ARCHITECTURE_MD_SECTIONS[2], "3. 分层架构");
  assert.equal(ARCHITECTURE_MD_SECTIONS[3], "4. 依赖规则");
  assert.equal(ARCHITECTURE_MD_SECTIONS[4], "5. 技术选型（引用 ETSB 决策表）");
  // 冻结保证（Object.isFrozen）
  assert.equal(Object.isFrozen(ARCHITECTURE_MD_SECTIONS), true);
});

// ============================================================================
// A2. DOMAIN_MODEL_MD_SECTIONS 章节结构与不可变性
// ============================================================================

test("A2. DOMAIN_MODEL_MD_SECTIONS 包含 4 个章节且冻结", () => {
  // 章节数应为 4（聚合清单/实体清单/值对象清单/领域事件清单）
  assert.equal(DOMAIN_MODEL_MD_SECTIONS.length, 4);
  // 章节顺序与内容对齐 EAG 方案 §5.2.2 DOMAIN-MODEL.md 模板
  assert.equal(DOMAIN_MODEL_MD_SECTIONS[0], "1. 聚合清单");
  assert.equal(DOMAIN_MODEL_MD_SECTIONS[1], "2. 实体清单");
  assert.equal(DOMAIN_MODEL_MD_SECTIONS[2], "3. 值对象清单");
  assert.equal(DOMAIN_MODEL_MD_SECTIONS[3], "4. 领域事件清单");
  // 冻结保证
  assert.equal(Object.isFrozen(DOMAIN_MODEL_MD_SECTIONS), true);
});

// ============================================================================
// A3. renderArchitectureMd 渲染：完整文档含全部 5 个章节
// ============================================================================

test("A3. renderArchitectureMd 渲染完整文档含全部 5 个章节 H2 标题", () => {
  const doc = buildFullArchitectureDocument();
  const md = renderArchitectureMd(doc);
  // 顶部 H1 标题
  assert.ok(md.includes("# ARCHITECTURE.md"), "应包含 H1 标题");
  // 5 个章节的 H2 标题
  for (const section of ARCHITECTURE_MD_SECTIONS) {
    assert.ok(md.includes(`## ${section}`), `应包含章节：${section}`);
  }
});

// ============================================================================
// A4. renderArchitectureMd 渲染：空文档处理（boundedContexts/layering/dependencyRules 为空）
// ============================================================================

test("A4. renderArchitectureMd 渲染空文档——所有清单为空时使用占位符", () => {
  const emptyDoc: ArchitectureDocument = {
    selectedParadigmId: "ddd-layered",
    paradigmRationale: "测试空文档",
    signalEvidence: {},
    boundedContexts: [],
    layering: [],
    dependencyRules: [],
  };
  const md = renderArchitectureMd(emptyDoc);
  // 仍应包含全部章节标题
  for (const section of ARCHITECTURE_MD_SECTIONS) {
    assert.ok(md.includes(`## ${section}`), `空文档仍应包含章节：${section}`);
  }
  // 空清单应使用占位符
  assert.ok(md.includes("（无限界上下文）"), "空 boundedContexts 应渲染占位");
  assert.ok(md.includes("（无分层定义）"), "空 layering 应渲染占位");
  assert.ok(md.includes("（无依赖规则）"), "空 dependencyRules 应渲染占位");
  // 空 signalEvidence 应有提示
  assert.ok(md.includes("（无信号证据"), "空 signalEvidence 应渲染提示");
});

// ============================================================================
// A5. renderArchitectureMd 渲染：包含范式 ID + 选择理由 + 信号证据
// ============================================================================

test("A5. renderArchitectureMd 渲染范式选择章节——ID + 理由 + 信号证据", () => {
  const doc = buildFullArchitectureDocument();
  const md = renderArchitectureMd(doc);
  // 范式 ID
  assert.ok(md.includes("**选中范式**：ddd-layered"), "应渲染范式 ID");
  // 选择理由
  assert.ok(md.includes("**选择理由**：业务复杂度高"), "应渲染范式选择理由");
  // 信号证据（4 个维度）
  assert.ok(md.includes("domainComplexity:"), "应渲染 domainComplexity 证据");
  assert.ok(md.includes("consistencyRequirement:"), "应渲染 consistencyRequirement 证据");
  assert.ok(md.includes("readWritePattern:"), "应渲染 readWritePattern 证据");
  assert.ok(md.includes("integrationComplexity:"), "应渲染 integrationComplexity 证据");
  // 证据值应引用需求原文
  assert.ok(md.includes("订单生命周期"), "证据应引用需求原文片段");
});

// ============================================================================
// A6. renderArchitectureMd 渲染：包含限界上下文与聚合清单
// ============================================================================

test("A6. renderArchitectureMd 渲染限界上下文章节——上下文名 + 职责 + 聚合清单", () => {
  const doc = buildFullArchitectureDocument();
  const md = renderArchitectureMd(doc);
  // 上下文名（H3）
  assert.ok(md.includes("### 订单上下文"), "应渲染限界上下文 H3 标题");
  // 职责
  assert.ok(md.includes("**职责**：处理订单生命周期"), "应渲染上下文职责");
  // 聚合清单
  assert.ok(md.includes("**聚合清单**："), "应渲染聚合清单标题");
  assert.ok(md.includes("OrderAggregate"), "应渲染聚合名 OrderAggregate");
  assert.ok(md.includes("PaymentAggregate"), "应渲染聚合名 PaymentAggregate");
});

test("A6b. renderArchitectureMd 渲染限界上下文——上下文无聚合时使用占位", () => {
  const doc: ArchitectureDocument = {
    ...buildFullArchitectureDocument(),
    boundedContexts: [
      {
        name: "空上下文",
        responsibility: "测试用",
        aggregates: [],
      },
    ],
  };
  const md = renderArchitectureMd(doc);
  assert.ok(md.includes("（无聚合）"), "空聚合清单应渲染占位");
});

// ============================================================================
// A7. renderArchitectureMd 渲染：包含分层定义与允许依赖
// ============================================================================

test("A7. renderArchitectureMd 渲染分层架构章节——层名 + 职责 + 允许依赖", () => {
  const doc = buildFullArchitectureDocument();
  const md = renderArchitectureMd(doc);
  // 4 层应全部渲染
  assert.ok(md.includes("**domain**"), "应渲染 domain 层");
  assert.ok(md.includes("**application**"), "应渲染 application 层");
  assert.ok(md.includes("**interfaces**"), "应渲染 interfaces 层");
  assert.ok(md.includes("**infrastructure**"), "应渲染 infrastructure 层");
  // 允许依赖渲染
  assert.ok(md.includes("允许依赖：application, domain"), "应渲染 interfaces 层允许依赖");
  // domain 层无允许依赖时应渲染"零外部依赖层"
  assert.ok(md.includes("（无，零外部依赖层）"), "domain 层无允许依赖时应渲染占位");
});

// ============================================================================
// A8. renderArchitectureMd 渲染：包含依赖规则（severity/fromLayer/forbiddenToLayers）
// ============================================================================

test("A8. renderArchitectureMd 渲染依赖规则章节——ID + 严重级别 + 描述 + 源层 + 禁止目标层", () => {
  const doc = buildFullArchitectureDocument();
  const md = renderArchitectureMd(doc);
  // 直接引用 DDD 范式的 5 条依赖规则，应全部渲染
  for (const rule of DDD_LAYERED_PARADIGM.dependencyRules) {
    assert.ok(md.includes(`**${rule.id}**`), `应渲染规则 ID：${rule.id}`);
    assert.ok(md.includes(`[${rule.severity}]`), `应渲染规则严重级别：${rule.severity}`);
    assert.ok(md.includes(`源层：${rule.fromLayer}`), `应渲染规则源层：${rule.fromLayer}`);
    // forbiddenToLayers 应渲染为逗号分隔字符串
    const forbiddenText = rule.forbiddenToLayers.join(", ");
    assert.ok(md.includes(`禁止目标层：${forbiddenText}`), `应渲染禁止目标层：${forbiddenText}`);
  }
});

// ============================================================================
// A9. renderArchitectureMd 渲染：技术选型章节为 ETSB 占位
// ============================================================================

test("A9. renderArchitectureMd 渲染技术选型章节——ETSB 占位说明", () => {
  const doc = buildFullArchitectureDocument();
  const md = renderArchitectureMd(doc);
  // 第 5 章节标题
  assert.ok(md.includes("## 5. 技术选型（引用 ETSB 决策表）"), "应渲染技术选型章节标题");
  // 占位说明（由 ETSB 模块填充）
  assert.ok(md.includes("ETSB"), "应包含 ETSB 关键词");
  assert.ok(md.includes("章节占位"), "应说明为章节占位");
});

// ============================================================================
// A10. renderDomainModelMd 渲染：完整文档含全部 4 个章节
// ============================================================================

test("A10. renderDomainModelMd 渲染完整文档含全部 4 个章节 H2 标题", () => {
  const doc = buildFullDomainModelDocument();
  const md = renderDomainModelMd(doc);
  // 顶部 H1 标题
  assert.ok(md.includes("# DOMAIN-MODEL.md"), "应包含 H1 标题");
  // 4 个章节的 H2 标题
  for (const section of DOMAIN_MODEL_MD_SECTIONS) {
    assert.ok(md.includes(`## ${section}`), `应包含章节：${section}`);
  }
});

// ============================================================================
// A11. renderDomainModelMd 渲染：空文档（所有清单为空）
// ============================================================================

test("A11. renderDomainModelMd 渲染空文档——所有清单为空时使用占位符", () => {
  const emptyDoc: DomainModelDocument = {
    aggregates: [],
    entities: [],
    valueObjects: [],
    domainEvents: [],
  };
  const md = renderDomainModelMd(emptyDoc);
  // 仍应包含全部章节标题
  for (const section of DOMAIN_MODEL_MD_SECTIONS) {
    assert.ok(md.includes(`## ${section}`), `空文档仍应包含章节：${section}`);
  }
  // 空清单应使用占位符
  assert.ok(md.includes("（无聚合）"), "空 aggregates 应渲染占位");
  assert.ok(md.includes("（无实体）"), "空 entities 应渲染占位");
  assert.ok(md.includes("（无值对象）"), "空 valueObjects 应渲染占位");
  assert.ok(md.includes("（无领域事件）"), "空 domainEvents 应渲染占位");
});

// ============================================================================
// A12. renderDomainModelMd 渲染：包含聚合清单（含不变式/内部实体/值对象/发布事件）
// ============================================================================

test("A12. renderDomainModelMd 渲染聚合清单——根实体 + 不变式 + 内部实体 + 值对象 + 发布事件", () => {
  const doc = buildFullDomainModelDocument();
  const md = renderDomainModelMd(doc);
  // 聚合名（H3）
  assert.ok(md.includes("### OrderAggregate"), "应渲染聚合 H3 标题");
  // 聚合根
  assert.ok(md.includes("**聚合根**：OrderEntity"), "应渲染聚合根");
  // 不变式
  assert.ok(md.includes("**不变式**"), "应渲染不变式标题");
  assert.ok(md.includes("订单总金额必须等于所有订单项金额之和"), "应渲染第 1 条不变式");
  assert.ok(md.includes("订单状态只能按状态机推进"), "应渲染第 2 条不变式");
  // 内部实体
  assert.ok(md.includes("**内部实体**：OrderLineEntity"), "应渲染内部实体");
  // 值对象
  assert.ok(md.includes("**值对象**：MoneyVO, AddressVO"), "应渲染值对象");
  // 发布事件
  assert.ok(md.includes("**发布事件**：OrderCreatedEvent, OrderConfirmedEvent"), "应渲染发布事件");
});

test("A12b. renderDomainModelMd 渲染聚合——无不变式/内部实体/值对象/事件时使用占位", () => {
  const doc: DomainModelDocument = {
    ...buildFullDomainModelDocument(),
    aggregates: [
      {
        name: "EmptyAggregate",
        rootEntity: "EmptyEntity",
        invariants: [],
        containedEntities: [],
        valueObjects: [],
        publishedEvents: [],
      },
    ],
  };
  const md = renderDomainModelMd(doc);
  assert.ok(md.includes("（无显式不变式）"), "空不变式应渲染占位");
  assert.ok(md.includes("**内部实体**：（无）"), "空内部实体应渲染占位");
  assert.ok(md.includes("**值对象**：（无）"), "空值对象应渲染占位");
  assert.ok(md.includes("**发布事件**：（无）"), "空发布事件应渲染占位");
});

// ============================================================================
// A13. renderDomainModelMd 渲染：包含实体清单（含属性 + 行为 + 触发事件）
// ============================================================================

test("A13. renderDomainModelMd 渲染实体清单——所属聚合 + 属性 + 行为 + 触发事件", () => {
  const doc = buildFullDomainModelDocument();
  const md = renderDomainModelMd(doc);
  // 实体名（H3）
  assert.ok(md.includes("### OrderEntity"), "应渲染实体 H3 标题");
  // 所属聚合
  assert.ok(md.includes("**所属聚合**：OrderAggregate"), "应渲染所属聚合");
  // 属性（name (type, 必填/可选)）
  assert.ok(md.includes("orderId (OrderId, 必填)"), "应渲染 orderId 属性");
  assert.ok(md.includes("status (OrderStatus, 必填)"), "应渲染 status 属性");
  assert.ok(md.includes("totalAmount (MoneyVO, 必填)"), "应渲染 totalAmount 属性");
  // 行为
  assert.ok(md.includes("confirm: 确认订单"), "应渲染 confirm 行为");
  // 触发事件
  assert.ok(md.includes("触发事件：OrderConfirmedEvent"), "应渲染行为触发的事件");
});

// ============================================================================
// A14. renderDomainModelMd 渲染：包含值对象清单（含不可变性保证）
// ============================================================================

test("A14. renderDomainModelMd 渲染值对象清单——属性 + 不可变性保证", () => {
  const doc = buildFullDomainModelDocument();
  const md = renderDomainModelMd(doc);
  // 值对象名（H3）
  assert.ok(md.includes("### MoneyVO"), "应渲染值对象 H3 标题");
  // 属性
  assert.ok(md.includes("amount (number, 必填)"), "应渲染 amount 属性");
  assert.ok(md.includes("currency (string, 必填)"), "应渲染 currency 属性");
  // 不可变性保证
  assert.ok(md.includes("**不可变性保证**"), "应渲染不可变性保证标题");
  assert.ok(md.includes("readonly + 构造后无 setter"), "应渲染不可变性保证内容");
});

// ============================================================================
// A15. renderDomainModelMd 渲染：包含领域事件清单（含发布者/订阅者/负载）
// ============================================================================

test("A15. renderDomainModelMd 渲染领域事件清单——发布者 + 订阅者 + 负载", () => {
  const doc = buildFullDomainModelDocument();
  const md = renderDomainModelMd(doc);
  // 事件名（H3）
  assert.ok(md.includes("### OrderCreatedEvent"), "应渲染事件 H3 标题");
  // 发布者
  assert.ok(md.includes("**发布者**：OrderAggregate"), "应渲染事件发布者");
  // 订阅者
  assert.ok(md.includes("**订阅者**：OrderProjection, InventorySaga"), "应渲染事件订阅者");
  // 负载属性
  assert.ok(md.includes("orderId (OrderId, 必填)"), "应渲染负载 orderId 属性");
  assert.ok(md.includes("createdAt (Date, 必填)"), "应渲染负载 createdAt 属性");
});

test("A15b. renderDomainModelMd 渲染领域事件——无订阅者时使用占位", () => {
  const doc: DomainModelDocument = {
    ...buildFullDomainModelDocument(),
    domainEvents: [
      {
        name: "LonelyEvent",
        publisher: "OrderAggregate",
        subscribers: [],
        payload: [],
      },
    ],
  };
  const md = renderDomainModelMd(doc);
  assert.ok(md.includes("**订阅者**：（无）"), "空订阅者应渲染占位");
  assert.ok(md.includes("（无属性）"), "空负载应渲染占位");
});

// ============================================================================
// A16. renderDomainModelMd 渲染：实体无行为时提示贫血模型
// ============================================================================

test("A16. renderDomainModelMd 渲染实体——无行为时提示贫血模型反模式", () => {
  const doc: DomainModelDocument = {
    ...buildFullDomainModelDocument(),
    entities: [
      {
        name: "AnemicEntity",
        aggregate: "OrderAggregate",
        attributes: [{ name: "id", type: "string", required: true }],
        behaviors: [], // 无行为，命中贫血模型提示
      },
    ],
  };
  const md = renderDomainModelMd(doc);
  assert.ok(md.includes("（无行为，可能命中贫血模型反模式）"), "空行为应渲染贫血模型提示");
});

// ============================================================================
// A17. validateArchitectureMd：完整 markdown 通过校验
// ============================================================================

test("A17. validateArchitectureMd——完整 markdown 通过校验", () => {
  const doc = buildFullArchitectureDocument();
  const md = renderArchitectureMd(doc);
  const result = validateArchitectureMd(md);
  assert.equal(result.valid, true, `应通过校验，但缺失：${result.missingSections.join(", ")}`);
  assert.equal(result.missingSections.length, 0);
});

// ============================================================================
// A18. validateArchitectureMd：缺失章节时返回 missingSections
// ============================================================================

test("A18. validateArchitectureMd——缺失章节时返回 missingSections", () => {
  // 构造缺失后 2 个章节的 markdown
  const doc = buildFullArchitectureDocument();
  const fullMd = renderArchitectureMd(doc);
  // 截断到第 3 章节之前，缺失第 3、4、5 章节
  const truncatedMd = fullMd.split("## 3. 分层架构")[0];
  const result = validateArchitectureMd(truncatedMd);
  assert.equal(result.valid, false);
  assert.equal(result.missingSections.length, 3);
  assert.ok(result.missingSections.includes("3. 分层架构"));
  assert.ok(result.missingSections.includes("4. 依赖规则"));
  assert.ok(result.missingSections.includes("5. 技术选型（引用 ETSB 决策表）"));
});

test("A18b. validateArchitectureMd——空字符串缺失全部 5 个章节", () => {
  const result = validateArchitectureMd("");
  assert.equal(result.valid, false);
  assert.equal(result.missingSections.length, 5);
});

// ============================================================================
// A19. validateDomainModelMd：完整 markdown 通过校验
// ============================================================================

test("A19. validateDomainModelMd——完整 markdown 通过校验", () => {
  const doc = buildFullDomainModelDocument();
  const md = renderDomainModelMd(doc);
  const result = validateDomainModelMd(md);
  assert.equal(result.valid, true, `应通过校验，但缺失：${result.missingSections.join(", ")}`);
  assert.equal(result.missingSections.length, 0);
});

// ============================================================================
// A20. validateDomainModelMd：缺失章节时返回 missingSections
// ============================================================================

test("A20. validateDomainModelMd——缺失章节时返回 missingSections", () => {
  const doc = buildFullDomainModelDocument();
  const fullMd = renderDomainModelMd(doc);
  // 截断到第 3 章节之前，缺失第 3、4 章节
  const truncatedMd = fullMd.split("## 3. 值对象清单")[0];
  const result = validateDomainModelMd(truncatedMd);
  assert.equal(result.valid, false);
  assert.equal(result.missingSections.length, 2);
  assert.ok(result.missingSections.includes("3. 值对象清单"));
  assert.ok(result.missingSections.includes("4. 领域事件清单"));
});

test("A20b. validateDomainModelMd——空字符串缺失全部 4 个章节", () => {
  const result = validateDomainModelMd("");
  assert.equal(result.valid, false);
  assert.equal(result.missingSections.length, 4);
});

// ============================================================================
// A21. 端到端：渲染后立即校验应通过（render → validate 往返一致性）
// ============================================================================

test("A21. 端到端往返——render → validate 应通过（ARCHITECTURE.md）", () => {
  // 用不同的文档（空 + 满）测试往返一致性
  const fullDoc = buildFullArchitectureDocument();
  const emptyDoc: ArchitectureDocument = {
    selectedParadigmId: "ddd-layered",
    paradigmRationale: "测试",
    signalEvidence: {},
    boundedContexts: [],
    layering: [],
    dependencyRules: [],
  };
  for (const doc of [fullDoc, emptyDoc]) {
    const md = renderArchitectureMd(doc);
    const result = validateArchitectureMd(md);
    assert.equal(result.valid, true, `渲染后的 markdown 应通过校验，但缺失：${result.missingSections.join(", ")}`);
  }
});

test("A21b. 端到端往返——render → validate 应通过（DOMAIN-MODEL.md）", () => {
  const fullDoc = buildFullDomainModelDocument();
  const emptyDoc: DomainModelDocument = {
    aggregates: [],
    entities: [],
    valueObjects: [],
    domainEvents: [],
  };
  for (const doc of [fullDoc, emptyDoc]) {
    const md = renderDomainModelMd(doc);
    const result = validateDomainModelMd(md);
    assert.equal(result.valid, true, `渲染后的 markdown 应通过校验，但缺失：${result.missingSections.join(", ")}`);
  }
});
