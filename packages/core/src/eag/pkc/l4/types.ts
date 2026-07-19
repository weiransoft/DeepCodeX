/**
 * PKC L4 交接文档层数据模型（EAG-P3 批次 11 Part B2）
 *
 * 本模块定义 EAG 方案 §5.11.3 / §5.11.4 PKC L4 交接文档层所需的全部结构化数据类型。
 * L4 交接文档层为团队提供"项目交接手册"——以七章结构 + 三级置信度方式，
 * 让接手者像资深程序员交接旧项目一样快速掌握项目全貌。
 *
 * 设计依据：
 * - EAG 方案 §5.11.3 交接文档层七章结构
 * - EAG 方案 §5.11.4 三级置信度标注（documented / inferred / verified）
 * - EAG-P3 批次 11 设计 §7.2 模块结构 / §7.3 核心类型设计
 *
 * 七章结构（顺序固定，对齐 §7.4 七章结构表）：
 * 1. 架构概览（architecture-overview，documented）
 * 2. 模块地图（module-map，verified）
 * 3. API 契约（api-contract，verified）
 * 4. 数据模型（data-model，verified）
 * 5. 测试策略（test-strategy，documented）
 * 6. 风险与技术债（risks-debt，inferred）
 * 7. 运维手册（runbook，inferred）
 *
 * 三级置信度（对齐 §5.11.4）：
 * - documented：文档化（来自 spec.md / CONSTITUTION.md / 需求文档）
 * - inferred：推断（仅基于代码静态分析推断，需人工审核后提升置信度）
 * - verified：已验证（代码 + 单测交叉验证）
 *
 * 不可变优先原则（对齐 §5.12.4 G-A6d 配置冻结）：
 * - 所有接口字段使用 readonly 修饰
 * - 数组使用 ReadonlyArray<T>
 * - 字面量联合类型避免字符串拼写错误
 * - 顶层配置常量使用 Object.freeze 冻结，防止运行期被 LLM 自改
 *
 * @module eag/pkc/l4/types
 */

// ============================================================================
// 1. 置信度等级（ConfidenceLevel）
// ============================================================================

/**
 * 置信度等级（字面量联合类型，对齐 §5.11.4 三级置信度）
 *
 * - documented：文档化（来自 spec.md / CONSTITUTION.md / 需求文档，置信度中等）
 * - inferred：推断（仅基于代码静态分析推断，置信度最低，需人工审核）
 * - verified：已验证（代码 + 单测交叉验证，置信度最高）
 *
 * 字面量联合而非 string，避免拼写错误。
 *
 * 排序（从低到高）：inferred < documented < verified
 */
export type ConfidenceLevel = "documented" | "inferred" | "verified";

/**
 * ConfidenceLevel 全部合法值（用于运行时枚举与排序）
 *
 * 使用 Object.freeze 冻结。顺序按置信度从低到高排列：
 * inferred < documented < verified
 *
 * 此顺序同时定义了 CONFIDENCE_PRIORITY 中的优先级数值。
 */
export const CONFIDENCE_LEVELS: ReadonlyArray<ConfidenceLevel> = Object.freeze(["inferred", "documented", "verified"]);

/**
 * 置信度优先级数值表（数值越小置信度越低）
 *
 * 用于 calculateOverallConfidence 排序比较：
 * - inferred=0（最低）
 * - documented=1（中等）
 * - verified=2（最高）
 *
 * 使用 Object.freeze 冻结，防止运行期被篡改。
 */
export const CONFIDENCE_PRIORITY: Readonly<Record<ConfidenceLevel, number>> = Object.freeze({
  inferred: 0,
  documented: 1,
  verified: 2,
});

/**
 * inferred 章节头部提示文案（对齐 §7.4 注释）
 *
 * 所有 confidence=inferred 的章节内容必须以该提示开头，
 * 提醒接手者该章节基于代码静态分析推断，需人工审核后提升置信度。
 *
 * 使用 Object.freeze 冻结。
 */
export const INFERRED_SECTION_NOTICE: string = Object.freeze(
  "> **置信度提示**：该章节基于代码静态分析推断，需人工审核后提升置信度。\n\n"
);

// ============================================================================
// 2. 交接文档章节（HandoverSection）
// ============================================================================

/**
 * 交接文档章节（单章定义）
 *
 * 字段全部 readonly——章节定义一经创建即不可变。
 *
 * 范例：
 *   {
 *     sectionId: "architecture-overview",
 *     title: "架构概览",
 *     order: 1,
 *     confidence: "documented",
 *     content: "## 架构概览\n\n本项目采用 DDD 分层架构...",
 *     sources: ["docs/architecture.md", "src/domain/"]
 *   }
 */
export interface HandoverSection {
  /** 章节 ID（kebab-case，如 "architecture-overview"） */
  readonly sectionId: string;
  /** 章节标题（人类可读，如 "架构概览"） */
  readonly title: string;
  /**
   * 章节顺序（1~7，对应七章结构）
   *
   * 取值约束：1 ≤ order ≤ 7
   */
  readonly order: number;
  /**
   * 置信度（documented / inferred / verified）
   *
   * - documented：文档化
   * - inferred：推断（需在 content 头部包含 INFERRED_SECTION_NOTICE 提示）
   * - verified：已验证
   */
  readonly confidence: ConfidenceLevel;
  /**
   * Markdown 格式的章节内容
   *
   * - 非 inferred 章节：直接 Markdown 内容
   * - inferred 章节：必须以 INFERRED_SECTION_NOTICE 提示开头
   */
  readonly content: string;
  /** 引用源文件路径列表（用于追溯证据） */
  readonly sources: ReadonlyArray<string>;
}

// ============================================================================
// 3. 交接文档（HandoverDocument）
// ============================================================================

/**
 * 交接文档（完整文档，由 7 个章节组成）
 *
 * 字段全部 readonly——文档一经生成即不可变。
 *
 * 范例：
 *   {
 *     documentId: "handover-a1b2c3d4",
 *     projectRoot: "/path/to/project",
 *     generatedAt: "2026-07-19T10:00:00.000Z",
 *     runId: "a1b2c3d4e5f6",
 *     sections: [architectureSection, moduleMapSection, ...],
 *     overallConfidence: "documented",
 *     tableOfContents: "1. [架构概览](#architecture-overview)\n..."
 *   }
 */
export interface HandoverDocument {
  /** 文档 ID（与 run-id 关联，如 "handover-a1b2c3d4"） */
  readonly documentId: string;
  /** 项目根目录（绝对路径） */
  readonly projectRoot: string;
  /** 生成时间（ISO 8601 字符串，如 "2026-07-19T10:00:00.000Z"） */
  readonly generatedAt: string;
  /** 关联的 run-id（追溯 RunState） */
  readonly runId: string;
  /** 章节列表（按 order 排序，共 7 章） */
  readonly sections: ReadonlyArray<HandoverSection>;
  /**
   * 整体置信度（取所有章节中最低的）
   *
   * 排序规则：inferred < documented < verified
   * 若任一章节为 inferred，整体即为 inferred。
   */
  readonly overallConfidence: ConfidenceLevel;
  /**
   * 目录（Markdown 格式，含章节标题与 anchor）
   *
   * 范例：
   *   1. [架构概览](#architecture-overview)
   *   2. [模块地图](#module-map)
   *   ...
   */
  readonly tableOfContents: string;
}

// ============================================================================
// 4. SectionBuilder 协议（章节构建器接口）
// ============================================================================

/**
 * 章节构建上下文（SectionBuilder.build 的入参）
 *
 * 携带章节构建所需的全部信息：
 * - projectRoot：项目根目录
 * - runId：run-id（追溯 RunState）
 * - pkcL1GlobalView：PKC L1 全局视图（来自 L1GlobalViewBuilder）
 * - pkcL2DependencyGraph：PKC L2 依赖图（来自 DependencyGraphBuilder）
 * - pkcL3BusinessFlows：PKC L3 业务流程（来自 BusinessFlowDiscoverer）
 * - fileMap：项目文件清单（相对路径 → 文件内容）
 * - testResults：测试执行结果
 *
 * 字段全部 readonly——上下文一经组装即不可变。
 *
 * 设计说明：
 * - fileMap 为主要数据源（SectionBuilder 通过 fileMap 读取项目文件内容）
 * - pkcL1GlobalView / pkcL2DependencyGraph / pkcL3BusinessFlows 为可选 PKC 上下文
 *   （未注入时 SectionBuilder 降级使用 fileMap 单独构建）
 * - testResults 为可选测试结果（TestStrategySectionBuilder 消费）
 */
export interface SectionBuildContext {
  /** 项目根目录（绝对路径） */
  readonly projectRoot: string;
  /** 关联的 run-id（追溯 RunState） */
  readonly runId: string;
  /** PKC L1 全局视图（可选，来自 L1GlobalViewBuilder.build()） */
  readonly pkcL1GlobalView?: unknown;
  /** PKC L2 依赖图（可选，来自 DependencyGraphBuilder） */
  readonly pkcL2DependencyGraph?: unknown;
  /** PKC L3 业务流程（可选，来自 BusinessFlowDiscoverer） */
  readonly pkcL3BusinessFlows?: unknown;
  /**
   * 项目文件清单（相对路径 → 文件内容）
   *
   * 键为相对 projectRoot 的路径（如 "src/index.ts"），值为文件内容（UTF-8 字符串）。
   * 由调用方预扫描项目后注入，避免 SectionBuilder 重复扫描磁盘。
   */
  readonly fileMap: Readonly<Record<string, string>>;
  /** 测试执行结果（可选，TestStrategySectionBuilder 消费） */
  readonly testResults?: ReadonlyArray<unknown>;
}

/**
 * SectionBuilder 协议（章节构建器接口）
 *
 * 所有 7 个 SectionBuilder 必须实现此接口，便于 HandoverDocumentBuilder 统一编排。
 *
 * 实现方负责：
 * 1. 声明 sectionId / title / order 元信息
 * 2. 实现 build(context) 方法，从 context 提取数据并生成 HandoverSection
 *
 * 调用方（HandoverDocumentBuilder）负责：
 * 1. 注入 SectionBuildContext
 * 2. 并行调用所有 SectionBuilder.build(context)
 * 3. 聚合章节为 HandoverDocument
 */
export interface SectionBuilder {
  /** 章节 ID（kebab-case，如 "architecture-overview"） */
  readonly sectionId: string;
  /** 章节标题（人类可读，如 "架构概览"） */
  readonly title: string;
  /**
   * 章节顺序（1~7，对应七章结构）
   *
   * 取值约束：1 ≤ order ≤ 7
   */
  readonly order: number;
  /**
   * 构建章节
   *
   * @param context 章节构建上下文（含项目信息、PKC L1/L2/L3 数据、fileMap 等）
   * @returns 构建好的 HandoverSection（不可变，字段 readonly）
   */
  build(context: SectionBuildContext): Promise<HandoverSection>;
}

// ============================================================================
// 5. 七章结构常量（SECTION_DEFINITIONS）
// ============================================================================

/**
 * 章节定义（单章元信息）
 *
 * 用于 SECTION_DEFINITIONS 表，描述每个章节的 ID / 标题 / 顺序 / 默认置信度。
 */
export interface SectionDefinition {
  /** 章节 ID（kebab-case） */
  readonly sectionId: string;
  /** 章节标题（中文） */
  readonly title: string;
  /** 章节顺序（1~7） */
  readonly order: number;
  /** 默认置信度（documented / inferred / verified） */
  readonly defaultConfidence: ConfidenceLevel;
}

/**
 * 七章结构定义表（对齐 §7.4 七章结构表）
 *
 * 顺序固定，对应 §7.4 表格：
 * 1. 架构概览（architecture-overview，documented）
 * 2. 模块地图（module-map，verified）
 * 3. API 契约（api-contract，verified）
 * 4. 数据模型（data-model，verified）
 * 5. 测试策略（test-strategy，documented）
 * 6. 风险与技术债（risks-debt，inferred）
 * 7. 运维手册（runbook，inferred）
 *
 * 使用 Object.freeze 冻结，防止运行期被 LLM 自改。
 */
export const SECTION_DEFINITIONS: ReadonlyArray<SectionDefinition> = Object.freeze([
  Object.freeze({
    sectionId: "architecture-overview",
    title: "架构概览",
    order: 1,
    defaultConfidence: "documented",
  }),
  Object.freeze({
    sectionId: "module-map",
    title: "模块地图",
    order: 2,
    defaultConfidence: "verified",
  }),
  Object.freeze({
    sectionId: "api-contract",
    title: "API 契约",
    order: 3,
    defaultConfidence: "verified",
  }),
  Object.freeze({
    sectionId: "data-model",
    title: "数据模型",
    order: 4,
    defaultConfidence: "verified",
  }),
  Object.freeze({
    sectionId: "test-strategy",
    title: "测试策略",
    order: 5,
    defaultConfidence: "documented",
  }),
  Object.freeze({
    sectionId: "risks-debt",
    title: "风险与技术债",
    order: 6,
    defaultConfidence: "inferred",
  }),
  Object.freeze({
    sectionId: "runbook",
    title: "运维手册",
    order: 7,
    defaultConfidence: "inferred",
  }),
]);

/**
 * 章节总数常量（对齐 §7.4 七章结构）
 *
 * HandoverDocumentBuilder 构造函数通过此常量校验 sectionBuilders.length。
 */
export const SECTION_COUNT = 7 as const;

// ============================================================================
// 6. 工厂函数与校验工具
// ============================================================================

/**
 * HandoverDocumentBuilder 配置/校验错误
 *
 * 当 SectionBuilder 数量不为 7 / 顺序重复 / ID 重复时抛出。
 */
export class HandoverDocumentBuilderError extends Error {
  /**
   * @param kind 错误类型
   *   - invalid-builder-count：builder 数量不为 7
   *   - duplicate-section-id：section ID 重复
   *   - duplicate-section-order：section order 重复
   *   - invalid-section-order：section order 不在 1~7 范围
   * @param detail 错误详情
   */
  constructor(
    public readonly kind:
      | "invalid-builder-count"
      | "duplicate-section-id"
      | "duplicate-section-order"
      | "invalid-section-order",
    public readonly detail: string
  ) {
    super(`HandoverDocumentBuilder 配置错误 [${kind}]：${detail}`);
    this.name = "HandoverDocumentBuilderError";
  }
}

/**
 * 校验置信度是否为合法值
 *
 * @param confidence 待校验的置信度值
 * @returns true=合法，false=非法
 */
export function isValidConfidenceLevel(confidence: unknown): confidence is ConfidenceLevel {
  return (
    typeof confidence === "string" &&
    (confidence === "documented" || confidence === "inferred" || confidence === "verified")
  );
}

/**
 * 比较两个置信度等级
 *
 * @param a 置信度 A
 * @param b 置信度 B
 * @returns 负数（a<b）/ 0（相等）/ 正数（a>b）
 */
export function compareConfidence(a: ConfidenceLevel, b: ConfidenceLevel): number {
  return CONFIDENCE_PRIORITY[a] - CONFIDENCE_PRIORITY[b];
}

/**
 * 取所有章节中最低的置信度
 *
 * 排序规则：inferred < documented < verified
 *
 * 实现说明（架构师审查 B2-M7 修复）：
 * - 空数组返回 "inferred"（防御性默认值）
 * - 初始值使用 sections[0].confidence（首个章节的置信度），而非误导性的 "verified"
 * - 使用 reduce 取最低
 *
 * @param sections 章节列表
 * @returns 最低置信度
 */
export function minConfidence(sections: ReadonlyArray<HandoverSection>): ConfidenceLevel {
  if (sections.length === 0) {
    return "inferred";
  }
  return sections.reduce<ConfidenceLevel>(
    (min, s) => (compareConfidence(s.confidence, min) < 0 ? s.confidence : min),
    sections[0].confidence
  );
}

/**
 * 创建 HandoverSection（带字段校验 + 冻结）
 *
 * 工厂函数模式：调用方传入字段，工厂函数完成校验并 Object.freeze 冻结。
 *
 * 校验规则：
 * - sectionId 必须为非空字符串
 * - title 必须为非空字符串
 * - order 必须为 1~7 的整数
 * - confidence 必须为合法 ConfidenceLevel
 * - content 必须为字符串
 * - sources 必须为数组
 *
 * @param input 章节字段
 * @returns 冻结后的 HandoverSection
 * @throws {HandoverDocumentBuilderError} 任一字段非法时抛出
 */
export function createHandoverSection(input: Readonly<HandoverSection>): Readonly<HandoverSection> {
  // 校验 sectionId
  if (typeof input.sectionId !== "string" || input.sectionId.trim().length === 0) {
    throw new HandoverDocumentBuilderError("duplicate-section-id", `sectionId 非法：${String(input.sectionId)}`);
  }
  // 校验 title
  if (typeof input.title !== "string" || input.title.trim().length === 0) {
    throw new HandoverDocumentBuilderError("duplicate-section-id", `title 非法：${String(input.title)}`);
  }
  // 校验 order（1~7 整数）
  if (typeof input.order !== "number" || !Number.isInteger(input.order) || input.order < 1 || input.order > 7) {
    throw new HandoverDocumentBuilderError(
      "invalid-section-order",
      `order 非法（必须为 1~7 整数）：${String(input.order)}`
    );
  }
  // 校验 confidence
  if (!isValidConfidenceLevel(input.confidence)) {
    throw new HandoverDocumentBuilderError("duplicate-section-id", `confidence 非法：${String(input.confidence)}`);
  }
  // 校验 content
  if (typeof input.content !== "string") {
    throw new HandoverDocumentBuilderError("duplicate-section-id", `content 非法：${typeof input.content}`);
  }
  // 校验 sources
  if (!Array.isArray(input.sources)) {
    throw new HandoverDocumentBuilderError("duplicate-section-id", `sources 非法：${typeof input.sources}`);
  }

  // inferred 章节必须在 content 头部包含提示
  if (input.confidence === "inferred" && !input.content.startsWith(INFERRED_SECTION_NOTICE)) {
    throw new HandoverDocumentBuilderError(
      "duplicate-section-id",
      `inferred 章节 content 必须以 INFERRED_SECTION_NOTICE 开头：sectionId=${input.sectionId}`
    );
  }

  return Object.freeze({
    sectionId: input.sectionId,
    title: input.title,
    order: input.order,
    confidence: input.confidence,
    content: input.content,
    sources: Object.freeze([...input.sources]),
  });
}
