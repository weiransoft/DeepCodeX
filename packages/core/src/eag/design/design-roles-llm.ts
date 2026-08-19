/**
 * DESIGN Loop LLM 驱动角色生产实现（EAG-P1 S3.2 接线批次）
 *
 * 本模块提供 DESIGN Loop 三角色编排中 PM 与架构师的生产级 LLM 实现：
 * - `LlmProductManager`（implement ProductManagerProtocol）：原始需求 → StructuredRequirement
 * - `LlmArchitect`（含重试反馈参数）：StructuredRequirement → ArchitectureDocument + DomainModelDocument
 * - `FeedbackAwareArchitect` / `FeedbackCapturingEvaluator`：重试反馈闭环包装器
 *   （兑现 design-orchestrator.ts 头注释"实际 LLM 集成时可通过 closure 或状态对象
 *   传递 verdict.reason 给架构师修正"的接线承诺）
 *
 * 实现模式（对齐 EagDynamicSuggester 先例，参照团队评审共识）：
 * - 经注入的 `createLLMClient` 工厂获取 LLMClient（与 session.ts createLLMClient 同源）
 * - prompt 构造委托 design-role-prompts.ts 纯函数
 * - LLM 输出经 JSON 提取（兼容 markdown 代码块包裹）+ 逐字段结构化校验
 * - **诚实失败（fail-closed）**：LLM 客户端不可用 / 调用异常 / 输出非法 JSON /
 *   字段校验失败时抛出 `DesignRoleError`，由 session.ts handleEagDesignCommand
 *   捕获后通知用户并标记会话 failed——绝不伪造任何"降级设计文档"
 *   （用户规则：禁止 mock / 占位 / 永远成功的假实现）
 *
 * 职责边界（对齐 EAG 方案 §5.2.1 Generator/Evaluator 分离）：
 * - 本模块是 Generator 侧（PM/架构师产出设计），不重复实现评估器判定逻辑
 * - layering 覆盖性 / 范式一致性 / 设计完整性 / 反模式零命中 / 信号证据强制
 *   等判定项由 StaticDesignEvaluator 独立判定（评估失败经重试反馈闭环修正）
 * - 架构师仅做结构化校验（字段类型/形状/非空），保证产出可被评估器安全消费
 * - dependencyRules 不由 LLM 产出——由范式注册表按所选范式权威填充（单一数据源）
 *
 * @module eag/design/design-roles-llm
 */

import type { LLMClient, LLMRequest } from "../../providers/llm-provider";
import type { ParadigmId, ParadigmLockConfig } from "../eak/types";
import { getParadigmById } from "../eak/paradigm-registry";
import type {
  AcceptanceCriterion,
  AggregateDefinition,
  ArchitectureDocument,
  AttributeDefinition,
  BoundedContext,
  BehaviorDefinition,
  DesignEvaluationVerdict,
  DomainEventDefinition,
  DomainModelDocument,
  DomainTerm,
  EntityDefinition,
  LayerDefinition,
  NonFunctionalCategory,
  NonFunctionalRequirement,
  ProjectContext,
  StructuredRequirement,
  UserStory,
  ValueObjectDefinition,
} from "./design-models";
import type { ArchitectProtocol, DesignEvaluatorProtocol, ProductManagerProtocol } from "./design-protocols";
import type { DesignArtifacts } from "./design-models";
import { buildArchitectPrompt, buildProductManagerPrompt } from "./design-role-prompts";

// ============================================================================
// 1. 错误类型与共享工具
// ============================================================================

/**
 * DESIGN Loop 角色执行错误
 *
 * LLM 客户端不可用 / 调用异常 / 输出解析或校验失败时抛出。
 * 携带 role 字段标识出错的角色（pm / architect），便于用户定位问题。
 */
export class DesignRoleError extends Error {
  /**
   * @param role 出错的角色（"pm" = 产品经理，"architect" = 架构师）
   * @param message 错误详情（中文，含具体失败原因）
   */
  constructor(
    public readonly role: "pm" | "architect",
    message: string
  ) {
    super(`[DESIGN Loop ${role === "pm" ? "产品经理" : "架构师"}角色] ${message}`);
    this.name = "DesignRoleError";
  }
}

/**
 * PM 角色默认最大输出 token 数
 *
 * 覆盖典型规模的结构化需求输出（多个用户故事 + 词汇表 + 非功能需求 JSON）。
 */
const DEFAULT_PM_MAX_TOKENS = 8192;

/**
 * 架构师角色默认最大输出 token 数
 *
 * 架构文档 + 领域模型（聚合/实体/值对象/事件）JSON 输出显著大于 PM 产出，
 * 取 2 倍 PM 预算。
 */
const DEFAULT_ARCHITECT_MAX_TOKENS = 16384;

/**
 * 角色调用默认采样温度
 *
 * 设计类任务需要一定创造性，但结构化输出优先确定性——对齐
 * EagDynamicSuggester 的 0.2 取值。
 */
const DEFAULT_ROLE_TEMPERATURE = 0.2;

/**
 * 角色构造选项
 */
export interface LlmDesignRoleOptions {
  /** LLM 客户端工厂（必须，与 session.ts createLLMClient 同源；返回 null 表示无可用凭据） */
  readonly createLLMClient: () => LLMClient | null;
  /** 最大输出 token（可选，PM/架构师分别有默认值） */
  readonly maxTokens?: number;
  /** 采样温度（可选，默认 0.2） */
  readonly temperature?: number;
}

/**
 * 从 LLM 原始文本输出中提取 JSON 字符串
 *
 * 兼容三种输出形态（按优先级依次尝试，全部 JSON.parse 失败才判定非法）：
 * 1. 整段文本即纯 JSON
 * 2. markdown 代码块包裹（```json ... ``` 或 ``` ... ```，含前后有杂讯的情况）
 * 3. 首个 "{" 到最后一个 "}" 的子串（LLM 前后夹杂解释文字时的兜底）
 *
 * @param text LLM 原始文本输出
 * @returns 首个可成功 JSON.parse 的候选字符串
 * @throws {DesignRoleError} 全部候选均无法解析时抛出（含原始输出片段供排障）
 */
function extractJsonCandidates(text: string, role: "pm" | "architect"): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    throw new DesignRoleError(role, "LLM 输出为空字符串");
  }

  // 候选 1：整段文本
  const candidates: string[] = [trimmed];

  // 候选 2：markdown 代码块（锚定或文中任意位置的第一个代码块）
  const anchoredBlock = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  if (anchoredBlock) {
    candidates.push(anchoredBlock[1].trim());
  }
  const anyBlock = /```(?:json)?\s*([\s\S]*?)\s*```/.exec(trimmed);
  if (anyBlock) {
    candidates.push(anyBlock[1].trim());
  }

  // 候选 3：首个 "{" 到最后一个 "}" 的子串（兜底剥离前后解释文字）
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }

  // 依次尝试解析，返回首个合法候选
  for (const candidate of candidates) {
    try {
      JSON.parse(candidate);
      return candidate;
    } catch {
      // 尝试下一个候选
    }
  }

  // 全部候选解析失败：抛出带原始输出片段的错误（截断防日志爆炸）
  throw new DesignRoleError(role, `LLM 输出不是合法 JSON（原始输出前 300 字符）：${trimmed.slice(0, 300)}`);
}

// ============================================================================
// 2. 结构化校验辅助函数（逐字段校验，错误信息含 JSON 路径）
// ============================================================================

/**
 * 校验值非空字符串
 *
 * @param value 待校验值
 * @param path 字段路径（如 "userStories[0].role"，用于错误定位）
 * @param role 出错时标记的角色
 * @returns 原样返回非空字符串
 * @throws {DesignRoleError} 非字符串或 trim 后为空时抛出
 */
function requireNonEmptyString(value: unknown, path: string, role: "pm" | "architect"): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new DesignRoleError(role, `字段 ${path} 必须为非空字符串（实际：${JSON.stringify(value)?.slice(0, 100)}）`);
  }
  return value.trim();
}

/**
 * 校验值为字符串数组（数组元素必须为非空字符串；数组本身可为空）
 *
 * @param value 待校验值
 * @param path 字段路径
 * @param role 出错时标记的角色
 * @returns 原样返回字符串数组（新数组，元素已 trim）
 * @throws {DesignRoleError} 非数组或元素非法时抛出
 */
function requireStringArray(value: unknown, path: string, role: "pm" | "architect"): string[] {
  if (!Array.isArray(value)) {
    throw new DesignRoleError(role, `字段 ${path} 必须为字符串数组（实际类型：${typeof value}）`);
  }
  return value.map((item, index) => requireNonEmptyString(item, `${path}[${index}]`, role));
}

/**
 * 校验值为对象数组（数组本身可为空，由调用方决定是否要求非空）
 *
 * @param value 待校验值
 * @param path 字段路径
 * @param role 出错时标记的角色
 * @returns 原样返回对象数组
 * @throws {DesignRoleError} 非数组或元素非对象时抛出
 */
function requireObjectArray(value: unknown, path: string, role: "pm" | "architect"): unknown[] {
  if (!Array.isArray(value)) {
    throw new DesignRoleError(role, `字段 ${path} 必须为数组（实际类型：${typeof value}）`);
  }
  value.forEach((item, index) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new DesignRoleError(role, `字段 ${path}[${index}] 必须为对象`);
    }
  });
  return value;
}

/**
 * 校验值为对象（非 null 非数组）
 *
 * @param value 待校验值
 * @param path 字段路径
 * @param role 出错时标记的角色
 * @returns 原样返回对象
 * @throws {DesignRoleError} 非对象时抛出
 */
function requireObject(value: unknown, path: string, role: "pm" | "architect"): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new DesignRoleError(role, `字段 ${path} 必须为对象（实际类型：${typeof value}）`);
  }
  return value as Record<string, unknown>;
}

/**
 * 校验属性定义数组（attributes / payload 共用结构）
 *
 * @param value 待校验值
 * @param path 字段路径
 * @param role 出错时标记的角色
 * @returns 规范化后的 AttributeDefinition 数组
 */
function parseAttributeArray(value: unknown, path: string, role: "pm" | "architect"): AttributeDefinition[] {
  const items = requireObjectArray(value, path, role);
  return items.map((item, index) => {
    const obj = requireObject(item, `${path}[${index}]`, role);
    return {
      name: requireNonEmptyString(obj["name"], `${path}[${index}].name`, role),
      type: requireNonEmptyString(obj["type"], `${path}[${index}].type`, role),
      required: obj["required"] === true,
    };
  });
}

// ============================================================================
// 3. LlmProductManager（implement ProductManagerProtocol）
// ============================================================================

/**
 * LLM 驱动的产品经理角色（implement ProductManagerProtocol）
 *
 * 执行流程：
 * 1. 经 buildProductManagerPrompt 构造角色 prompt（唤起知识：用户故事模板 + Gherkin）
 * 2. 经注入的 LLM 客户端发起非流式调用
 * 3. 提取 JSON 并逐字段结构化校验（userStories/domainGlossary/nonFunctionalRequirements）
 * 4. 返回冻结的 StructuredRequirement
 *
 * 失败语义（fail-closed）：任一步骤失败抛 DesignRoleError，不产出伪造需求。
 */
export class LlmProductManager implements ProductManagerProtocol {
  /** 角色构造选项（冻结） */
  private readonly options: Readonly<{
    createLLMClient: () => LLMClient | null;
    maxTokens: number;
    temperature: number;
  }>;

  /**
   * @param options 角色构造选项（createLLMClient 必填）
   * @throws {Error} createLLMClient 缺失或非函数时抛出
   */
  constructor(options: Readonly<LlmDesignRoleOptions>) {
    if (typeof options.createLLMClient !== "function") {
      throw new Error("LlmProductManager: createLLMClient 必须为函数");
    }
    this.options = Object.freeze({
      createLLMClient: options.createLLMClient,
      maxTokens: options.maxTokens ?? DEFAULT_PM_MAX_TOKENS,
      temperature: options.temperature ?? DEFAULT_ROLE_TEMPERATURE,
    });
  }

  /**
   * 将原始自然语言需求结构化为 StructuredRequirement
   *
   * @param rawRequirement 原始业务需求（自然语言）
   * @param projectContext 项目上下文（棕地场景时提供，注入 prompt 供术语对齐）
   * @returns 结构化需求（userStories/domainGlossary/nonFunctionalRequirements）
   * @throws {DesignRoleError} LLM 不可用/调用失败/输出非法/校验失败时抛出
   */
  async structureRequirement(rawRequirement: string, projectContext?: ProjectContext): Promise<StructuredRequirement> {
    // 步骤 1：构造角色 prompt
    const messages = buildProductManagerPrompt({ rawRequirement, projectContext });

    // 步骤 2：调用 LLM（client 不可用/调用异常 → DesignRoleError）
    const rawText = await this.callLlm(messages, "pm");

    // 步骤 3：提取 JSON + 逐字段校验
    return this.parseStructuredRequirement(rawText);
  }

  /**
   * 发起 LLM 非流式调用并返回文本内容
   *
   * @param messages prompt 消息数组（system + user）
   * @param role 角色标识（错误信息用）
   * @returns LLM 输出文本（已 trim）
   * @throws {DesignRoleError} 客户端不可用或调用异常时抛出
   */
  private async callLlm(
    messages: ReadonlyArray<{ readonly role: "system" | "user"; readonly content: string }>,
    role: "pm" | "architect"
  ): Promise<string> {
    const client = this.options.createLLMClient();
    if (!client) {
      throw new DesignRoleError(role, "LLM 客户端不可用（无可用凭据或配置缺失），无法执行角色任务");
    }
    try {
      const response = await client.createMessage({
        // prompt 消息仅含 role/content，LLMClient 要求 SessionMessage 形态；
        // 运行时 provider 只读取 role/content，通过类型断言兼容（EagDynamicSuggester 同款先例）
        messages: messages as unknown as LLMRequest["messages"],
        thinkingEnabled: false,
        maxTokens: this.options.maxTokens,
        temperature: this.options.temperature,
      });
      return response.content.trim();
    } catch (err) {
      // 注意：DesignRoleError 不再包装（保持原始错误语义，避免双重包装）
      if (err instanceof DesignRoleError) {
        throw err;
      }
      const reason = err instanceof Error ? err.message : String(err);
      throw new DesignRoleError(role, `LLM 调用失败：${reason}`);
    }
  }

  /**
   * 解析并校验 PM 的 LLM 输出为 StructuredRequirement
   *
   * 校验规则（结构化校验，非 mock）：
   * - userStories：非空数组；每个故事 id/role/action/benefit 非空；
   *   acceptanceCriteria 非空且 given/when/then 非空；domainEventCandidates 为字符串数组
   * - domainGlossary：数组（可为空）；每个术语 term/definition 非空，synonyms 为字符串数组
   * - nonFunctionalRequirements：数组（可为空）；category ∈ 5 个合法分类；description 非空
   *
   * @param rawText LLM 原始输出文本
   * @returns 结构化需求
   * @throws {DesignRoleError} 输出非法或校验失败时抛出（错误含字段路径）
   */
  private parseStructuredRequirement(rawText: string): StructuredRequirement {
    const role = "pm" as const;
    const jsonText = extractJsonCandidates(rawText, role);
    const raw = requireObject(JSON.parse(jsonText), "root", role);

    // ===== userStories（非空数组）=====
    const storyItems = requireObjectArray(raw["userStories"], "userStories", role);
    if (storyItems.length === 0) {
      throw new DesignRoleError(role, "字段 userStories 不得为空（至少 1 个用户故事）");
    }
    const userStories: UserStory[] = storyItems.map((item, index) => {
      const obj = requireObject(item, `userStories[${index}]`, role);
      const acItems = requireObjectArray(obj["acceptanceCriteria"], `userStories[${index}].acceptanceCriteria`, role);
      if (acItems.length === 0) {
        throw new DesignRoleError(
          role,
          `字段 userStories[${index}].acceptanceCriteria 不得为空（每个故事至少 1 条验收标准）`
        );
      }
      const acceptanceCriteria: AcceptanceCriterion[] = acItems.map((acItem, acIndex) => {
        const acObj = requireObject(acItem, `userStories[${index}].acceptanceCriteria[${acIndex}]`, role);
        return {
          id: requireNonEmptyString(acObj["id"], `userStories[${index}].acceptanceCriteria[${acIndex}].id`, role),
          given: requireNonEmptyString(
            acObj["given"],
            `userStories[${index}].acceptanceCriteria[${acIndex}].given`,
            role
          ),
          when: requireNonEmptyString(acObj["when"], `userStories[${index}].acceptanceCriteria[${acIndex}].when`, role),
          then: requireNonEmptyString(acObj["then"], `userStories[${index}].acceptanceCriteria[${acIndex}].then`, role),
        };
      });
      return {
        id: requireNonEmptyString(obj["id"], `userStories[${index}].id`, role),
        role: requireNonEmptyString(obj["role"], `userStories[${index}].role`, role),
        action: requireNonEmptyString(obj["action"], `userStories[${index}].action`, role),
        benefit: requireNonEmptyString(obj["benefit"], `userStories[${index}].benefit`, role),
        acceptanceCriteria,
        domainEventCandidates: requireStringArray(
          obj["domainEventCandidates"],
          `userStories[${index}].domainEventCandidates`,
          role
        ),
      };
    });

    // ===== domainGlossary（可为空数组）=====
    const glossaryItems = requireObjectArray(raw["domainGlossary"] ?? [], "domainGlossary", role);
    const domainGlossary: DomainTerm[] = glossaryItems.map((item, index) => {
      const obj = requireObject(item, `domainGlossary[${index}]`, role);
      return {
        term: requireNonEmptyString(obj["term"], `domainGlossary[${index}].term`, role),
        definition: requireNonEmptyString(obj["definition"], `domainGlossary[${index}].definition`, role),
        synonyms: requireStringArray(obj["synonyms"] ?? [], `domainGlossary[${index}].synonyms`, role),
      };
    });

    // ===== nonFunctionalRequirements（可为空数组；category ∈ 5 分类）=====
    const VALID_NFR_CATEGORIES: ReadonlySet<string> = new Set([
      "performance",
      "security",
      "availability",
      "scalability",
      "consistency",
    ]);
    const nfrItems = requireObjectArray(raw["nonFunctionalRequirements"] ?? [], "nonFunctionalRequirements", role);
    const nonFunctionalRequirements: NonFunctionalRequirement[] = nfrItems.map((item, index) => {
      const obj = requireObject(item, `nonFunctionalRequirements[${index}]`, role);
      const category = requireNonEmptyString(obj["category"], `nonFunctionalRequirements[${index}].category`, role);
      if (!VALID_NFR_CATEGORIES.has(category)) {
        throw new DesignRoleError(
          role,
          `字段 nonFunctionalRequirements[${index}].category 必须为 performance/security/availability/scalability/consistency 之一（实际：${category}）`
        );
      }
      return {
        id: requireNonEmptyString(obj["id"], `nonFunctionalRequirements[${index}].id`, role),
        category: category as NonFunctionalCategory,
        description: requireNonEmptyString(obj["description"], `nonFunctionalRequirements[${index}].description`, role),
      };
    });

    return { userStories, domainGlossary, nonFunctionalRequirements };
  }
}

// ============================================================================
// 4. LlmArchitect（含重试反馈参数，经 FeedbackAwareArchitect 适配协议）
// ============================================================================

/**
 * LLM 驱动的架构师角色（经 FeedbackAwareArchitect 包装后满足 ArchitectProtocol）
 *
 * 与 ProductManagerProtocol 的差异：本类额外接受第 4 个可选参数
 * `previousVerdict`（上一轮评估失败判定），用于 DESIGN Loop 重试时
 * 携带评估反馈修正设计（对齐 design-orchestrator.ts 重试语义）。
 *
 * 执行流程：
 * 1. 经 buildArchitectPrompt 构造角色 prompt（唤起知识：4 范式全量 + 信号 + 反模式
 *    + 上轮评估反馈 + 棕地上下文 + 范式锁定提示）
 * 2. 经注入的 LLM 客户端发起非流式调用
 * 3. 提取 JSON 并逐字段结构化校验
 * 4. 组装 ArchitectureDocument（dependencyRules 由范式注册表权威填充）
 *    + DomainModelDocument
 *
 * 失败语义（fail-closed）：任一步骤失败抛 DesignRoleError，不产出伪造设计。
 */
export class LlmArchitect {
  /** 角色构造选项（冻结） */
  private readonly options: Readonly<{
    createLLMClient: () => LLMClient | null;
    maxTokens: number;
    temperature: number;
  }>;

  /**
   * @param options 角色构造选项（createLLMClient 必填）
   * @throws {Error} createLLMClient 缺失或非函数时抛出
   */
  constructor(options: Readonly<LlmDesignRoleOptions>) {
    if (typeof options.createLLMClient !== "function") {
      throw new Error("LlmArchitect: createLLMClient 必须为函数");
    }
    this.options = Object.freeze({
      createLLMClient: options.createLLMClient,
      maxTokens: options.maxTokens ?? DEFAULT_ARCHITECT_MAX_TOKENS,
      temperature: options.temperature ?? DEFAULT_ROLE_TEMPERATURE,
    });
  }

  /**
   * 根据结构化需求产出架构设计文档 + 领域模型文档
   *
   * @param requirement PM 产出的结构化需求
   * @param paradigmLock 可选，范式锁定配置（锁定时 prompt 强制采用锁定范式）
   * @param projectContext 项目上下文（棕地场景时提供）
   * @param previousVerdict 可选，上一轮评估失败判定（重试时注入 prompt 供修正设计）
   * @returns 架构师产出：architecture（ARCHITECTURE.md 内容模型）+ domainModel（DOMAIN-MODEL.md 内容模型）
   * @throws {DesignRoleError} LLM 不可用/调用失败/输出非法/校验失败时抛出
   */
  async designArchitecture(
    requirement: StructuredRequirement,
    paradigmLock?: ParadigmLockConfig,
    projectContext?: ProjectContext,
    previousVerdict?: DesignEvaluationVerdict
  ): Promise<{ architecture: ArchitectureDocument; domainModel: DomainModelDocument }> {
    // 步骤 1：构造角色 prompt（含范式库全量 + 反馈 + 锁定 + 棕地上下文）
    const messages = buildArchitectPrompt({
      requirement,
      paradigmLock,
      projectContext,
      previousVerdict,
    });

    // 步骤 2：调用 LLM
    const rawText = await this.callLlm(messages);

    // 步骤 3：解析校验 + 组装产出
    return this.parseArchitectOutput(rawText);
  }

  /**
   * 发起 LLM 非流式调用并返回文本内容
   *
   * @param messages prompt 消息数组（system + user）
   * @returns LLM 输出文本（已 trim）
   * @throws {DesignRoleError} 客户端不可用或调用异常时抛出
   */
  private async callLlm(
    messages: ReadonlyArray<{ readonly role: "system" | "user"; readonly content: string }>
  ): Promise<string> {
    const client = this.options.createLLMClient();
    if (!client) {
      throw new DesignRoleError("architect", "LLM 客户端不可用（无可用凭据或配置缺失），无法执行角色任务");
    }
    try {
      const response = await client.createMessage({
        messages: messages as unknown as LLMRequest["messages"],
        thinkingEnabled: false,
        maxTokens: this.options.maxTokens,
        temperature: this.options.temperature,
      });
      return response.content.trim();
    } catch (err) {
      if (err instanceof DesignRoleError) {
        throw err;
      }
      const reason = err instanceof Error ? err.message : String(err);
      throw new DesignRoleError("architect", `LLM 调用失败：${reason}`);
    }
  }

  /**
   * 解析并校验架构师的 LLM 输出并组装产出
   *
   * 校验规则（结构化校验；layering 覆盖性/范式一致性/设计完整性/反模式
   * 等设计判定由 StaticDesignEvaluator 独立判定，经重试反馈闭环修正）：
   * - selectedParadigmId：必须为 4 个合法范式 ID 之一（锁定一致性由评估器判定）
   * - paradigmRationale：非空字符串
   * - signalEvidence：对象（键值均为字符串；非空性由评估器判定）
   * - boundedContexts：非空数组，name/responsibility 非空，aggregates 为字符串数组
   * - layering：非空数组，name/responsibility 非空，allowedDependencies 为字符串数组
   * - domainModel.aggregates：非空数组，各字段结构合法
   * - domainModel.entities：非空数组，behaviors 非空（红线 E7 贫血模型禁令的结构化底线）
   * - domainModel.valueObjects / domainEvents：数组（可为空），各字段结构合法
   *
   * 组装规则（单一数据源）：
   * - architectureDocument.dependencyRules 直接取范式注册表中该范式的
   *   dependencyRules（不由 LLM 产出，保证与范式定义逐字一致）
   *
   * @param rawText LLM 原始输出文本
   * @returns 架构师产出
   * @throws {DesignRoleError} 输出非法或校验失败时抛出（错误含字段路径）
   */
  private parseArchitectOutput(rawText: string): {
    architecture: ArchitectureDocument;
    domainModel: DomainModelDocument;
  } {
    const role = "architect" as const;
    const jsonText = extractJsonCandidates(rawText, role);
    const raw = requireObject(JSON.parse(jsonText), "root", role);

    // ===== selectedParadigmId（必须是合法范式 ID）=====
    const selectedParadigmId = requireNonEmptyString(raw["selectedParadigmId"], "selectedParadigmId", role);
    const paradigm = getParadigmById(selectedParadigmId as ParadigmId);
    if (paradigm === null) {
      throw new DesignRoleError(
        role,
        `字段 selectedParadigmId 必须为 ddd-layered/clean-architecture/cqrs-es/microservice 之一（实际：${selectedParadigmId}）`
      );
    }

    // ===== paradigmRationale（非空）=====
    const paradigmRationale = requireNonEmptyString(raw["paradigmRationale"], "paradigmRationale", role);

    // ===== signalEvidence（对象；键值为字符串；非空性由评估器判定）=====
    const evidenceRaw = requireObject(raw["signalEvidence"] ?? {}, "signalEvidence", role);
    const signalEvidence: Record<string, string> = {};
    for (const [key, value] of Object.entries(evidenceRaw)) {
      signalEvidence[key] = requireNonEmptyString(value, `signalEvidence.${key}`, role);
    }

    // ===== boundedContexts（非空数组）=====
    const bcItems = requireObjectArray(raw["boundedContexts"], "boundedContexts", role);
    if (bcItems.length === 0) {
      throw new DesignRoleError(role, "字段 boundedContexts 不得为空（至少 1 个限界上下文）");
    }
    const boundedContexts: BoundedContext[] = bcItems.map((item, index) => {
      const obj = requireObject(item, `boundedContexts[${index}]`, role);
      return {
        name: requireNonEmptyString(obj["name"], `boundedContexts[${index}].name`, role),
        responsibility: requireNonEmptyString(obj["responsibility"], `boundedContexts[${index}].responsibility`, role),
        aggregates: requireStringArray(obj["aggregates"] ?? [], `boundedContexts[${index}].aggregates`, role),
      };
    });

    // ===== layering（非空数组；层名覆盖性由评估器判定）=====
    const layerItems = requireObjectArray(raw["layering"], "layering", role);
    if (layerItems.length === 0) {
      throw new DesignRoleError(role, "字段 layering 不得为空（必须产出分层定义）");
    }
    const layering: LayerDefinition[] = layerItems.map((item, index) => {
      const obj = requireObject(item, `layering[${index}]`, role);
      return {
        name: requireNonEmptyString(obj["name"], `layering[${index}].name`, role),
        responsibility: requireNonEmptyString(obj["responsibility"], `layering[${index}].responsibility`, role),
        allowedDependencies: requireStringArray(
          obj["allowedDependencies"] ?? [],
          `layering[${index}].allowedDependencies`,
          role
        ),
      };
    });

    // ===== domainModel =====
    const dmRaw = requireObject(raw["domainModel"], "domainModel", role);

    // 聚合（非空数组）
    const aggItems = requireObjectArray(dmRaw["aggregates"], "domainModel.aggregates", role);
    if (aggItems.length === 0) {
      throw new DesignRoleError(role, "字段 domainModel.aggregates 不得为空（每个用户故事至少 1 个聚合承载）");
    }
    const aggregates: AggregateDefinition[] = aggItems.map((item, index) => {
      const obj = requireObject(item, `domainModel.aggregates[${index}]`, role);
      return {
        name: requireNonEmptyString(obj["name"], `domainModel.aggregates[${index}].name`, role),
        rootEntity: requireNonEmptyString(obj["rootEntity"], `domainModel.aggregates[${index}].rootEntity`, role),
        invariants: requireStringArray(obj["invariants"] ?? [], `domainModel.aggregates[${index}].invariants`, role),
        containedEntities: requireStringArray(
          obj["containedEntities"] ?? [],
          `domainModel.aggregates[${index}].containedEntities`,
          role
        ),
        valueObjects: requireStringArray(
          obj["valueObjects"] ?? [],
          `domainModel.aggregates[${index}].valueObjects`,
          role
        ),
        publishedEvents: requireStringArray(
          obj["publishedEvents"] ?? [],
          `domainModel.aggregates[${index}].publishedEvents`,
          role
        ),
      };
    });

    // 实体（非空数组；behaviors 非空——红线 E7 贫血模型禁令的结构化底线）
    const entityItems = requireObjectArray(dmRaw["entities"], "domainModel.entities", role);
    if (entityItems.length === 0) {
      throw new DesignRoleError(role, "字段 domainModel.entities 不得为空（聚合根必须有实体定义）");
    }
    const entities: EntityDefinition[] = entityItems.map((item, index) => {
      const obj = requireObject(item, `domainModel.entities[${index}]`, role);
      const behaviorItems = requireObjectArray(obj["behaviors"], `domainModel.entities[${index}].behaviors`, role);
      if (behaviorItems.length === 0) {
        throw new DesignRoleError(
          role,
          `字段 domainModel.entities[${index}].behaviors 不得为空（红线 E7 贫血模型禁令：实体必须内聚业务方法）`
        );
      }
      const behaviors: BehaviorDefinition[] = behaviorItems.map((bItem, bIndex) => {
        const bObj = requireObject(bItem, `domainModel.entities[${index}].behaviors[${bIndex}]`, role);
        return {
          name: requireNonEmptyString(bObj["name"], `domainModel.entities[${index}].behaviors[${bIndex}].name`, role),
          description: requireNonEmptyString(
            bObj["description"],
            `domainModel.entities[${index}].behaviors[${bIndex}].description`,
            role
          ),
          publishedEvents: requireStringArray(
            bObj["publishedEvents"] ?? [],
            `domainModel.entities[${index}].behaviors[${bIndex}].publishedEvents`,
            role
          ),
        };
      });
      return {
        name: requireNonEmptyString(obj["name"], `domainModel.entities[${index}].name`, role),
        aggregate: requireNonEmptyString(obj["aggregate"], `domainModel.entities[${index}].aggregate`, role),
        attributes: parseAttributeArray(obj["attributes"] ?? [], `domainModel.entities[${index}].attributes`, role),
        behaviors,
      };
    });

    // 值对象（可为空数组）
    const voItems = requireObjectArray(dmRaw["valueObjects"] ?? [], "domainModel.valueObjects", role);
    const valueObjects: ValueObjectDefinition[] = voItems.map((item, index) => {
      const obj = requireObject(item, `domainModel.valueObjects[${index}]`, role);
      return {
        name: requireNonEmptyString(obj["name"], `domainModel.valueObjects[${index}].name`, role),
        attributes: parseAttributeArray(obj["attributes"] ?? [], `domainModel.valueObjects[${index}].attributes`, role),
        immutabilityGuarantee: requireNonEmptyString(
          obj["immutabilityGuarantee"],
          `domainModel.valueObjects[${index}].immutabilityGuarantee`,
          role
        ),
      };
    });

    // 领域事件（可为空数组；与用户故事的对应关系由评估器判定设计完整性）
    const evtItems = requireObjectArray(dmRaw["domainEvents"] ?? [], "domainModel.domainEvents", role);
    const domainEvents: DomainEventDefinition[] = evtItems.map((item, index) => {
      const obj = requireObject(item, `domainModel.domainEvents[${index}]`, role);
      return {
        name: requireNonEmptyString(obj["name"], `domainModel.domainEvents[${index}].name`, role),
        publisher: requireNonEmptyString(obj["publisher"], `domainModel.domainEvents[${index}].publisher`, role),
        subscribers: requireStringArray(
          obj["subscribers"] ?? [],
          `domainModel.domainEvents[${index}].subscribers`,
          role
        ),
        payload: parseAttributeArray(obj["payload"] ?? [], `domainModel.domainEvents[${index}].payload`, role),
      };
    });

    // ===== 组装 ArchitectureDocument =====
    // 关键：dependencyRules 取范式注册表权威定义（单一数据源，不由 LLM 产出），
    // 保证评估器"范式一致性"判定中按 id 比对必然一致
    const architecture: ArchitectureDocument = {
      selectedParadigmId: paradigm.id,
      paradigmRationale,
      signalEvidence,
      boundedContexts,
      layering,
      dependencyRules: paradigm.dependencyRules,
    };

    // ===== 组装 DomainModelDocument =====
    const domainModel: DomainModelDocument = {
      aggregates,
      entities,
      valueObjects,
      domainEvents,
    };

    return { architecture, domainModel };
  }
}

// ============================================================================
// 5. 重试反馈闭环包装器（兑现 orchestrator 头注释的接线承诺）
// ============================================================================

/**
 * 反馈感知架构师（implement ArchitectProtocol）
 *
 * 包装 LlmArchitect，在 DESIGN Loop 重试循环中携带上轮评估失败判定：
 * - DesignLoopOrchestrator 的 ArchitectProtocol 接口未定义"接收上轮失败原因"
 *   参数（接口限制），本包装器通过内部状态对象传递（orchestrator 头注释
 *   "实际 LLM 集成时可通过 closure 或状态对象传递 verdict.reason"的落地）
 * - 反馈按 requirement 对象引用隔离：新一轮 run()（新 requirement 对象）
 *   不再携带上一轮的过时反馈，避免跨需求污染
 */
export class FeedbackAwareArchitect implements ArchitectProtocol {
  /** 内部 LLM 架构师（真实执行体） */
  private readonly inner: LlmArchitect;
  /** 最近一次评估判定（与对应的 requirement 对象引用绑定，实现跨轮隔离） */
  private lastFeedback: { requirement: StructuredRequirement; verdict: DesignEvaluationVerdict } | null = null;

  /**
   * @param inner 内部 LLM 架构师实例
   */
  constructor(inner: LlmArchitect) {
    this.inner = inner;
  }

  /**
   * 记录最近一次评估判定（由 FeedbackCapturingEvaluator 在每次评估后回调）
   *
   * @param requirement 评估对应的结构化需求（用于跨轮引用隔离）
   * @param verdict 评估判定（passed=false 时下一轮架构师调用将携带该反馈）
   */
  recordVerdict(requirement: StructuredRequirement, verdict: DesignEvaluationVerdict): void {
    this.lastFeedback = { requirement, verdict };
  }

  /**
   * 执行架构设计（携带同需求的上轮失败反馈）
   *
   * @param requirement PM 产出的结构化需求
   * @param paradigmLock 可选，范式锁定配置
   * @param projectContext 项目上下文（棕地场景时提供）
   * @returns 架构师产出（内部委托 LlmArchitect，注入同需求的 lastFeedback）
   */
  async designArchitecture(
    requirement: StructuredRequirement,
    paradigmLock?: ParadigmLockConfig,
    projectContext?: ProjectContext
  ): Promise<{ architecture: ArchitectureDocument; domainModel: DomainModelDocument }> {
    // 仅当反馈绑定的 requirement 与本次调用为同一对象（同一轮 DESIGN Loop 的重试）时注入
    const feedback =
      this.lastFeedback && this.lastFeedback.requirement === requirement ? this.lastFeedback.verdict : undefined;
    return this.inner.designArchitecture(requirement, paradigmLock, projectContext, feedback);
  }
}

/**
 * 反馈捕获评估器（implement DesignEvaluatorProtocol）
 *
 * 包装真实评估器（StaticDesignEvaluator），在每次评估完成后将判定回调给
 * FeedbackAwareArchitect，构成"评估失败 → 架构师带反馈重试"的闭环。
 *
 * 设计理由（对齐 §5.2.1 Generator/Evaluator 分离）：
 * - 本包装器不改变任何评估判定（透传 inner 结果），仅旁路记录判定
 * - 真实评估逻辑仍在 StaticDesignEvaluator，评估器独立性不受影响
 */
export class FeedbackCapturingEvaluator implements DesignEvaluatorProtocol {
  /** 内部真实评估器 */
  private readonly inner: DesignEvaluatorProtocol;
  /** 判定回调（注入 FeedbackAwareArchitect.recordVerdict） */
  private readonly onVerdict: (requirement: StructuredRequirement, verdict: DesignEvaluationVerdict) => void;

  /**
   * @param inner 内部真实评估器（StaticDesignEvaluator）
   * @param onVerdict 评估完成后的判定回调
   */
  constructor(
    inner: DesignEvaluatorProtocol,
    onVerdict: (requirement: StructuredRequirement, verdict: DesignEvaluationVerdict) => void
  ) {
    this.inner = inner;
    this.onVerdict = onVerdict;
  }

  /**
   * 对设计产出进行独立评估并透传判定（旁路记录）
   *
   * @param artifacts 设计产出（含 structuredRequirement，用于反馈绑定）
   * @param paradigm 选中的范式定义
   * @returns 透传内部评估器的判定结果
   */
  async evaluate(
    artifacts: DesignArtifacts,
    paradigm: Parameters<DesignEvaluatorProtocol["evaluate"]>[1]
  ): Promise<DesignEvaluationVerdict> {
    const verdict = await this.inner.evaluate(artifacts, paradigm);
    // 旁路记录判定（供下一轮架构师重试时作为修正反馈）
    this.onVerdict(artifacts.structuredRequirement, verdict);
    return verdict;
  }
}
