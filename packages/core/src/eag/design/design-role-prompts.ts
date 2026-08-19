/**
 * DESIGN Loop 角色_prompt 构造器（EAG-P1 S3.2 接线批次）
 *
 * 本模块为 LLM 驱动的 PM（LlmProductManager）与架构师（LlmArchitect）提供
 * 角色 prompt 构造函数，对齐 EAG 方案 §5.3 多角色编排层的"唤起知识"设计：
 * - PM 唤起知识：用户故事模板（角色+动作+价值三段式）+ 验收标准 Gherkin 语法
 * - 架构师唤起知识：范式库（4 范式全量注入）+ applicabilitySignals 适用信号
 *   + antiPatterns 反模式清单 + dependencyRules 依赖规则
 *
 * 设计原则（对齐 eag/dynamic/prompts/eag-suggestion-prompt.ts 先例）：
 * - prompt builder 为纯函数：输入上下文 → 输出 {role, content} 消息数组
 * - 范式数据来自 paradigm-registry 冻结数据源（无副作用，可安全在纯函数中读取）
 * - 输出格式约定为"纯 JSON、无 markdown 代码块包裹"（解析端兼容代码块包裹）
 *
 * 降级语义说明（重要，对齐评审共识"诚实失败"）：
 * - 本模块只负责构造 prompt，不做降级——LLM 调用失败/输出非法时由
 *   design-roles-llm.ts 抛出 DesignRoleError（fail-closed），
 *   session.ts handleEagDesignCommand 捕获后通知用户并标记会话 failed，
 *   绝不伪造任何"降级设计文档"（用户规则：禁止 mock/占位实现）。
 *
 * @module eag/design/design-role-prompts
 */

import type { ArchitectureParadigm, ParadigmLockConfig } from "../eak/types";
import { getAllParadigms } from "../eak/paradigm-registry";
import type { ProjectContext, StructuredRequirement } from "./design-models";
import type { DesignEvaluationVerdict } from "./design-models";

// ============================================================================
// 1. PM（产品经理）prompt 构造
// ============================================================================

/**
 * PM prompt 上下文参数
 */
export interface ProductManagerPromptContext {
  /** 原始业务需求（自然语言） */
  readonly rawRequirement: string;
  /** 项目上下文（棕地场景时提供，绿地场景省略） */
  readonly projectContext?: ProjectContext;
}

/**
 * PM 输出 JSON 的结构示例（注入 prompt，指导 LLM 输出格式）
 *
 * 注意：与 StructuredRequirement 类型字段一一对应；
 * domainEventCandidates 使用英文过去式 + Event 后缀命名。
 */
const PM_OUTPUT_SCHEMA_EXAMPLE = `{
  "userStories": [
    {
      "id": "US-001",
      "role": "订单管理员",
      "action": "创建订单",
      "benefit": "跟踪订单状态",
      "acceptanceCriteria": [
        { "id": "AC-001", "given": "订单管理员已登录系统", "when": "提交新订单表单", "then": "订单状态变为待支付" }
      ],
      "domainEventCandidates": ["OrderCreatedEvent"]
    }
  ],
  "domainGlossary": [
    { "term": "订单", "definition": "客户提交的一次购买请求，含商品明细与金额", "synonyms": ["订单单据", "Order"] }
  ],
  "nonFunctionalRequirements": [
    { "id": "NFR-001", "category": "consistency", "description": "订单状态在支付完成后必须立即一致" }
  ]
}`;

/**
 * 构造 PM（产品经理）角色 prompt
 *
 * 算法：
 * 1. 构造 system prompt（角色职责 + 唤起知识 + 强制约束 + 输出格式）
 * 2. 构造 user prompt（原始需求 + 棕地上下文提示）
 *
 * @param context PM prompt 上下文
 * @returns 供 LLMClient 使用的消息数组（system + user）
 */
export function buildProductManagerPrompt(
  context: Readonly<ProductManagerPromptContext>
): ReadonlyArray<{ readonly role: "system" | "user"; readonly content: string }> {
  // 棕地场景提示：PM 应参考既有领域模型避免术语漂移（§5.3 PM 角色职责）
  const brownfieldHint = context.projectContext
    ? `【棕地项目上下文】
- 项目根目录：${context.projectContext.projectRoot}
${context.projectContext.existingParadigm ? `- 既有范式：${context.projectContext.existingParadigm}（结构化需求应与该范式的领域术语保持一致）` : ""}
${context.projectContext.existingDomainModelUri ? `- 既有领域模型文档：${context.projectContext.existingDomainModelUri}（领域词汇表应优先沿用既有术语，避免术语漂移）` : ""}
`
    : "";

  const systemPrompt = `你是 DeepCodeX EAG 体系的产品经理（PM）角色，负责将原始业务需求结构化为标准 StructuredRequirement。

【唤起知识】
1. 用户故事模板：三段式"作为<角色>，我希望<动作>，以便<价值>"
2. 验收标准：Gherkin 语法（Given 前置条件 / When 触发动作 / Then 预期结果）
3. 领域事件候选：业务事实的过去式英文命名（如"创建订单" → OrderCreatedEvent）

【职责】
1. 逐条解析原始需求，抽取用户故事（角色/动作/价值三段式，不得虚构需求中不存在的故事）
2. 为每个用户故事编写至少 1 条 Gherkin 验收标准
3. 为每个用户故事提取至少 1 个领域事件候选名（英文过去式 + Event 后缀）
4. 构建领域词汇表（term/definition/synonyms），消除同名异义与同义异名
5. 提取非功能需求（category 仅允许 performance/security/availability/scalability/consistency）

【强制约束】
- userStories 不得为空，每个故事的 role/action/benefit 必须为非空字符串
- 每个故事至少 1 条验收标准，given/when/then 必须非空
- 领域事件候选名必须是合法英文标识符且以 Event 结尾（如 OrderCreatedEvent）
- id 采用自增编号格式：US-001 / AC-001 / NFR-001
- 忠实于原始需求原文，不得虚构、不得遗漏关键业务诉求
- 输出必须是纯 JSON 对象，不得包含 markdown 代码块标记或任何解释文字

【输出格式】
${PM_OUTPUT_SCHEMA_EXAMPLE}`;

  const userPrompt = `${brownfieldHint}【原始业务需求】
${context.rawRequirement}

请将上述需求结构化为 JSON（严格遵循输出格式，直接输出 JSON，不要任何解释）。`;

  return [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];
}

// ============================================================================
// 2. 架构师 prompt 构造
// ============================================================================

/**
 * 架构师 prompt 上下文参数
 */
export interface ArchitectPromptContext {
  /** PM 产出的结构化需求 */
  readonly requirement: StructuredRequirement;
  /** 可选，范式锁定配置（锁定时架构师必须采用锁定范式） */
  readonly paradigmLock?: ParadigmLockConfig;
  /** 项目上下文（棕地场景时提供） */
  readonly projectContext?: ProjectContext;
  /** 上一轮评估失败的判定（重试时提供，架构师据此修正设计） */
  readonly previousVerdict?: DesignEvaluationVerdict;
}

/**
 * 架构师输出 JSON 的结构示例（注入 prompt，指导 LLM 输出格式）
 *
 * 注意：
 * - 不含 dependencyRules 字段（由范式注册表权威提供，架构师不复制）
 * - layering 层名集合必须与所选范式 dependencyRules 涉及的层名集合完全一致
 */
const ARCHITECT_OUTPUT_SCHEMA_EXAMPLE = `{
  "selectedParadigmId": "ddd-layered",
  "paradigmRationale": "业务实体关系丰富且要求强一致，DDD 分层最匹配",
  "signalEvidence": {
    "domainComplexity": "需求包含订单/库存/支付多个实体与状态转换，业务复杂度高",
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

/**
 * 将范式定义格式化为 prompt 可读的摘要文本
 *
 * 包含：ID/名称/描述/适用信号/依赖规则涉及的层名/依赖规则明细/反模式清单。
 * 架构师据此完成范式选择与 layering 覆盖。
 *
 * @param paradigm 范式定义
 * @returns 单范式的多行摘要文本
 */
function formatParadigmForPrompt(paradigm: ArchitectureParadigm): string {
  // 依赖规则涉及的层名集合（fromLayer + forbiddenToLayers 去重）
  // layering 必须恰好覆盖这些层（集合相等），评估器据此判定范式一致性
  const layerNames = new Set<string>();
  for (const rule of paradigm.dependencyRules) {
    layerNames.add(rule.fromLayer);
    for (const target of rule.forbiddenToLayers) {
      layerNames.add(target);
    }
  }

  const signals = paradigm.applicabilitySignals;
  const signalText = `domainComplexity=${signals.domainComplexity}, consistencyRequirement=${signals.consistencyRequirement}, readWritePattern=${signals.readWritePattern}, integrationComplexity=${signals.integrationComplexity}`;

  const ruleLines = paradigm.dependencyRules
    .map(
      (rule) =>
        `  - ${rule.id}（${rule.severity}）：${rule.fromLayer} 不得依赖 [${rule.forbiddenToLayers.join(", ")}]——${rule.description}`
    )
    .join("\n");

  const antiPatternLines = paradigm.antiPatterns
    .map((ap) => `  - ${ap.id}（${ap.severity}/${ap.detection}）：${ap.name}——${ap.description}`)
    .join("\n");

  return `### 范式：${paradigm.name}（id: ${paradigm.id}）
- 描述：${paradigm.description}
- 适用信号：${signalText}
- layering 必须恰好覆盖的层名集合：[${Array.from(layerNames).join(", ")}]
- 依赖规则：
${ruleLines}
- 反模式清单：
${antiPatternLines}`;
}

/**
 * 构造架构师角色 prompt
 *
 * 算法：
 * 1. 从范式注册表读取全部 4 个范式并格式化（唤起知识：范式库+信号+反模式）
 * 2. 注入结构化需求 JSON / 范式锁定配置 / 棕地上下文 / 上轮评估反馈
 * 3. 组合 system prompt（职责+约束+输出格式）与 user prompt
 *
 * @param context 架构师 prompt 上下文
 * @returns 供 LLMClient 使用的消息数组（system + user）
 */
export function buildArchitectPrompt(
  context: Readonly<ArchitectPromptContext>
): ReadonlyArray<{ readonly role: "system" | "user"; readonly content: string }> {
  // 步骤 1：全量范式注入（自主选择时 LLM 需要 4 个范式全部信息做信号匹配）
  const paradigmList = getAllParadigms()
    .map((p) => formatParadigmForPrompt(p))
    .join("\n\n");

  // 步骤 2：范式锁定提示（锁定时跳过信号判定，直接采用锁定范式）
  const lockHint = context.paradigmLock?.locked
    ? `【范式锁定（组织规范，必须遵守）】
- 已锁定范式：${context.paradigmLock.paradigmId}
- 锁定原因：${context.paradigmLock.reason || "组织规范要求"}
- 你必须直接采用锁定的范式（selectedParadigmId 必须等于 "${context.paradigmLock.paradigmId}"），
  但仍需填写 signalEvidence（基于需求原文说明四个信号维度的实际判定，供审计）。`
    : `【范式选择】
- 未锁定：你需要根据结构化需求与各范式的适用信号自主选择最匹配的范式
- signalEvidence 必须引用需求原文片段作为打分依据（每个维度一条，共 4 条）`;

  // 步骤 3：棕地上下文提示（优先沿用既有范式与领域模型）
  const brownfieldHint = context.projectContext
    ? `【棕地项目上下文】
- 项目根目录：${context.projectContext.projectRoot}
${context.projectContext.existingParadigm ? `- 既有范式：${context.projectContext.existingParadigm}（优先沿用而非自主另选）` : ""}
${context.projectContext.existingDomainModelUri ? `- 既有领域模型文档：${context.projectContext.existingDomainModelUri}（在其上增量扩展而非推倒重建）` : ""}
`
    : "";

  // 步骤 4：上轮评估失败反馈（重试场景，携带 verdict 判定修正设计）
  const feedbackHint = context.previousVerdict
    ? `【上一轮评估未通过——请修正设计后重新输出】
- 失败原因：${context.previousVerdict.reason}
- 问题清单：
${context.previousVerdict.findings.map((f) => `  * ${f}`).join("\n")}
- 修复建议：${context.previousVerdict.suggestedFix || "（无）"}
`
    : "";

  const systemPrompt = `你是 DeepCodeX EAG 体系的架构师角色，负责根据结构化需求产出架构设计文档（ARCHITECTURE.md 内容模型）与领域模型文档（DOMAIN-MODEL.md 内容模型）。

【唤起知识：架构范式库（4 个范式全量定义）】
${paradigmList}

【职责】
1. ${context.paradigmLock?.locked ? "采用锁定的范式" : "根据适用信号选择最匹配的范式"}，并填写 paradigmRationale（中文说明选择理由）
2. 填写 signalEvidence：4 个维度（domainComplexity/consistencyRequirement/readWritePattern/integrationComplexity）各至少一条，必须引用需求原文片段
3. 划分限界上下文（boundedContexts）：每个上下文含名称/职责/聚合名清单，聚合名须与 domainModel.aggregates 一致
4. 产出分层定义（layering）：层名集合必须与你所选范式的"layering 必须恰好覆盖的层名集合"完全一致（不多不少），
   各层 allowedDependencies 不得违反该范式的依赖规则与反模式
5. 设计领域模型（domainModel）：
   - 聚合（aggregates）：每个用户故事至少有 1 个聚合承载；CQRS-ES 范式下每个聚合的 publishedEvents 不得为空
   - 实体（entities）：每个实体必须有业务方法（behaviors 非空，严禁贫血模型）；aggregate 字段引用已定义的聚合名
   - 值对象（valueObjects）：不可变领域对象（如 MoneyVO），可为空数组
   - 领域事件（domainEvents）：每个用户故事的 domainEventCandidates 事件名必须在 domainEvents 中定义；publisher 必须是已定义的聚合名；事件名以 Event 结尾

【强制约束】
- selectedParadigmId 必须是 4 个范式 ID 之一${context.paradigmLock?.locked ? `（当前已锁定为 "${context.paradigmLock.paradigmId}"，不得另选）` : ""}
- 不得输出 dependencyRules 字段——依赖规则由范式注册表权威提供，由系统按所选范式自动填充
- layering 层名集合与所选范式规定的层名集合必须完全一致（集合相等）
- boundedContexts 与 domainModel.aggregates 均不得为空
- 输出必须是纯 JSON 对象，不得包含 markdown 代码块标记或任何解释文字

【输出格式】
${ARCHITECT_OUTPUT_SCHEMA_EXAMPLE}`;

  // 结构化需求序列化为 JSON 注入（LLM 据此设计聚合/事件/上下文）
  const requirementJson = JSON.stringify(context.requirement, null, 2);

  const userPrompt = `${feedbackHint}${brownfieldHint}${lockHint}

【结构化需求（PM 产出）】
${requirementJson}

请基于上述需求产出架构设计文档与领域模型文档的 JSON（严格遵循输出格式，直接输出 JSON，不要任何解释）。`;

  return [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];
}
