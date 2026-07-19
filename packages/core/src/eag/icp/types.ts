/**
 * ICP（Industry Compliance Packs，行业合规包）数据模型（EAG-P3 批次 11 §6.3）
 *
 * 本模块定义 EAG 方案 §5.9.2 ICP（行业合规包）层所需的全部结构化数据类型。
 * ICP 让系统像资深 QA 一样按行业法规校验代码与运行期行为，覆盖三大法规域：
 * - GMP（药品生产质量管理规范）
 * - CFR（21 CFR Part 11 电子记录与电子签名）
 * - ALCOA+（FDA 数据完整性原则扩展）
 *
 * 设计依据：
 * - EAG 方案 §5.9.2 ICP 合规证据
 * - EAG-P3 批次 11 设计 §6.1 B1 设计目标
 * - EAG-P3 批次 11 设计 §6.3 B1 核心类型设计
 *
 * 文件状态说明（EAG-P3 批次 11 Part B 子代理 F 创建）：
 * - 本文件由 B5 子代理 F 创建，按 §6.3 完整实现 B5 所需的合规证据类型
 * - B5（gate-g7-checker.ts 合规证据扩展）依赖本文件的 ComplianceEvidenceReport /
 *   ComplianceRuleResult / ComplianceSeverity 等类型
 * - B1 子代理 D 在并行实施 ICP 完整模块（含 packs / compliance-engine / evidence-collector），
 *   若 B1 完整实现后本文件已存在，B1 子代理 D 可直接复用或协调扩展
 *
 * 不可变优先原则（对齐 §5.12.4 G-A6d 配置冻结）：
 * - 所有接口字段使用 readonly 修饰
 * - 数组使用 ReadonlyArray<T>
 * - 字面量联合类型避免字符串拼写错误
 * - 顶层配置常量使用 Object.freeze 冻结，防止运行期被 LLM 自改
 *
 * @module eag/icp/types
 */

// ============================================================================
// 1. 合规包 ID 与严重性
// ============================================================================

/**
 * 合规规则 ID 前缀（字面量联合类型）
 *
 * 对齐三大法规域：
 * - GMP：药品生产质量管理规范（Good Manufacturing Practice）
 * - CFR：21 CFR Part 11 电子记录与电子签名（美国联邦法规第 21 卷第 11 部分）
 * - ALCOA：FDA 数据完整性原则扩展（Attributable / Legible / Contemporaneous / Original / Accurate）
 *
 * 字面量联合而非 string，避免拼写错误。
 *
 * 设计依据：§6.3 CompliancePackId
 */
export type CompliancePackId = "GMP" | "CFR" | "ALCOA";

/**
 * CompliancePackId 全部合法值（用于运行时枚举与配置校验）
 *
 * 使用 Object.freeze 冻结（§5.12.4 G-A6d 配置冻结）。
 * 顺序对齐三大法规域的自然顺序（GMP → CFR → ALCOA）。
 */
export const COMPLIANCE_PACK_IDS: ReadonlyArray<CompliancePackId> = Object.freeze(["GMP", "CFR", "ALCOA"]);

/**
 * 合规规则严重性（与 RedlineSeverity 对齐，使用小写）
 *
 * - blocker：阻塞级（不通过即 PR 打回，不可豁免）
 * - major：主要级（打回但可人工豁免）
 * - warning：警告级（仅提示不打回）
 *
 * 字面量联合而非 string，避免拼写错误。
 *
 * 设计依据：§6.3 ComplianceSeverity
 */
export type ComplianceSeverity = "blocker" | "major" | "warning";

/**
 * ComplianceSeverity 全部合法值（用于运行时枚举与配置校验）
 *
 * 使用 Object.freeze 冻结。顺序对齐严重性从高到低（blocker → major → warning）。
 */
export const COMPLIANCE_SEVERITIES: ReadonlyArray<ComplianceSeverity> = Object.freeze(["blocker", "major", "warning"]);

// ============================================================================
// 2. 检查类型与证据类型
// ============================================================================

/**
 * 合规规则检查类型（字面量联合类型）
 *
 * - static：静态检查（基于代码 AST / 配置文件 / 文档结构，不运行业务代码）
 * - dynamic：动态检查（运行测试用例 / 调用 API / 查询数据库验证运行期行为）
 * - hybrid：混合检查（先静态扫描后动态验证）
 *
 * 字面量联合而非 string，避免拼写错误。
 *
 * 设计依据：§6.3 ComplianceCheckKind
 */
export type ComplianceCheckKind = "static" | "dynamic" | "hybrid";

/**
 * ComplianceCheckKind 全部合法值（用于运行时枚举与配置校验）
 *
 * 使用 Object.freeze 冻结。
 */
export const COMPLIANCE_CHECK_KINDS: ReadonlyArray<ComplianceCheckKind> = Object.freeze([
  "static",
  "dynamic",
  "hybrid",
]);

/**
 * 合规证据类型（字面量联合类型）
 *
 * 描述证据的来源形式，用于 PR 描述渲染与审计追溯：
 * - code-snippet：代码片段（含文件路径与行号范围）
 * - test-output：测试输出（含测试文件路径与执行结果）
 * - config：配置文件（含文件路径与字段值）
 * - log：日志条目（含时间戳与日志级别）
 * - audit-trail：审计追踪记录（含操作人与时间戳）
 *
 * 字面量联合而非 string，避免拼写错误。
 *
 * 设计依据：§6.3 ComplianceEvidenceKind
 */
export type ComplianceEvidenceKind = "code-snippet" | "test-output" | "config" | "log" | "audit-trail";

/**
 * ComplianceEvidenceKind 全部合法值（用于运行时枚举与配置校验）
 *
 * 使用 Object.freeze 冻结。
 */
export const COMPLIANCE_EVIDENCE_KINDS: ReadonlyArray<ComplianceEvidenceKind> = Object.freeze([
  "code-snippet",
  "test-output",
  "config",
  "log",
  "audit-trail",
]);

/**
 * 合规证据（单条证据记录）
 *
 * 用于 ComplianceRuleResult.evidence 列表，描述规则校验过程中采集到的具体证据。
 *
 * 字段全部 readonly——证据一经采集即不可变。
 *
 * 范例：
 *   {
 *     kind: "code-snippet",
 *     source: "src/services/OrderService.ts:42-58",
 *     content: "async updateOrder(...) { await auditLog.record({...}); ... }"
 *   }
 *
 * 设计依据：§6.3 ComplianceEvidence
 */
export interface ComplianceEvidence {
  /** 证据类型 */
  readonly kind: ComplianceEvidenceKind;
  /** 证据来源（文件路径:行号 或 log:时间戳） */
  readonly source: string;
  /** 证据内容（代码片段 / 测试输出 / 配置值 / 日志条目） */
  readonly content: string;
}

// ============================================================================
// 3. 合规检查上下文与检查器函数签名
// ============================================================================

/**
 * 静态检查器函数签名（基于代码 AST / 配置文件校验）
 *
 * @param context 合规检查上下文（含 projectRoot / fileMap / astMap / configMap）
 * @returns 检查结果（passed + 证据列表 + reason）
 *
 * 设计依据：§6.3 StaticCheckerFn
 */
export type StaticCheckerFn = (context: ComplianceCheckContext) => ComplianceRuleResult;

/**
 * 动态检查器函数签名（基于测试用例 / API 调用校验）
 *
 * @param context 合规检查上下文（含 projectRoot / testRunner / apiClient）
 * @returns 检查结果（passed + 证据列表 + reason）
 *
 * 设计依据：§6.3 DynamicCheckerFn
 */
export type DynamicCheckerFn = (context: ComplianceCheckContext) => Promise<ComplianceRuleResult>;

/**
 * 合规测试运行器协议（动态检查用）
 *
 * 由调用方注入（如 TestingLoopRequest 中携带的 testRunner）。
 *
 * 设计依据：§6.3 ComplianceTestRunner
 */
export interface ComplianceTestRunner {
  /** 运行指定测试文件，返回退出码与输出 */
  run(testPath: string): Promise<{ exitCode: number; output: string }>;
}

/**
 * 合规 API 客户端协议（动态检查用）
 *
 * 设计依据：§6.3 ComplianceApiClient
 */
export interface ComplianceApiClient {
  /** 调用指定 API，返回响应 */
  call(endpoint: string, method: string, body?: unknown): Promise<{ status: number; body: unknown }>;
}

/**
 * 合规检查上下文（ComplianceEngine 调用检查器时传入）
 *
 * 携带合规检查所需的全部运行时信息：
 * - projectRoot：项目根目录
 * - fileMap：项目文件清单（相对路径 → 文件内容）
 * - astMap：TypeScript AST 映射（文件路径 → AST 节点）
 * - configMap：配置文件映射（如 .eag/icp-config.yml）
 * - testRunner：测试运行器（动态检查用）
 * - apiClient：API 客户端（动态检查用，可选）
 *
 * 字段全部 readonly——上下文一经组装即不可变。
 *
 * 设计依据：§6.3 ComplianceCheckContext
 */
export interface ComplianceCheckContext {
  /** 项目根目录（绝对路径） */
  readonly projectRoot: string;
  /** 项目文件清单（相对路径 → 文件内容字符串） */
  readonly fileMap: Readonly<Record<string, string>>;
  /** TypeScript AST 映射（文件路径 → AST 节点，由 ts-morph 解析） */
  readonly astMap: Readonly<Record<string, unknown>>;
  /** 配置文件映射（如 .eag/icp-config.yml 解析后的对象） */
  readonly configMap: Readonly<Record<string, unknown>>;
  /** 测试运行器（动态检查用，调用 npm test 或 node --test） */
  readonly testRunner?: ComplianceTestRunner;
  /** API 客户端（动态检查用，调用业务 API 验证运行期行为） */
  readonly apiClient?: ComplianceApiClient;
}

// ============================================================================
// 4. 合规规则与合规包
// ============================================================================

/**
 * 合规规则（单条规则的完整定义）
 *
 * 字段全部 readonly——规则一经定义即不可变（§5.12.4 G-A6d 配置冻结）。
 *
 * 范例：
 *   {
 *     ruleId: "GMP-01",
 *     packId: "GMP",
 *     title: "工艺验证（Process Validation）",
 *     description: "关键工艺步骤必须有对应的验证测试",
 *     regulatoryReference: "21 CFR 211.110(a)",
 *     checkKind: "static",
 *     severity: "blocker",
 *     staticChecker: (ctx) => { ... }
 *   }
 *
 * 设计依据：§6.3 ComplianceRule
 */
export interface ComplianceRule {
  /** 规则 ID（如 "GMP-01" / "CFR-03" / "ALCOA-05"） */
  readonly ruleId: string;
  /** 所属合规包 ID（GMP / CFR / ALCOA） */
  readonly packId: CompliancePackId;
  /** 规则标题（人类可读） */
  readonly title: string;
  /** 规则描述（含校验逻辑说明） */
  readonly description: string;
  /** 法规条款引用（如 "21 CFR 211.110(a)" / "ICH Q9" / "FDA Guidance 2018"） */
  readonly regulatoryReference: string;
  /** 检查类型（static / dynamic / hybrid） */
  readonly checkKind: ComplianceCheckKind;
  /** 严重性（blocker / major / warning） */
  readonly severity: ComplianceSeverity;
  /** 静态检查器（checkKind 为 static 或 hybrid 时必填） */
  readonly staticChecker?: StaticCheckerFn;
  /** 动态检查器（checkKind 为 dynamic 或 hybrid 时必填） */
  readonly dynamicChecker?: DynamicCheckerFn;
}

/**
 * 合规包（规则集合）
 *
 * 字段全部 readonly——包一经定义即不可变。
 *
 * 范例：
 *   {
 *     packId: "GMP",
 *     packName: "药品生产质量管理规范",
 *     version: "1.0.0",
 *     rules: [GMP_01, GMP_02, ..., GMP_06]
 *   }
 *
 * 设计依据：§6.3 CompliancePack
 */
export interface CompliancePack {
  /** 合规包 ID */
  readonly packId: CompliancePackId;
  /** 合规包名称 */
  readonly packName: string;
  /** 合规包版本（语义化版本） */
  readonly version: string;
  /** 规则列表 */
  readonly rules: ReadonlyArray<ComplianceRule>;
}

// ============================================================================
// 5. 合规规则校验结果与合规证据报告（B5 关键依赖）
// ============================================================================

/**
 * 合规规则校验结果（单条规则的执行产出）
 *
 * 字段全部 readonly——结果一经采集即不可变。
 *
 * 范例：
 *   {
 *     ruleId: "GMP-01",
 *     passed: true,
 *     severity: "blocker",
 *     evidence: [{ kind: "test-output", source: "tests/compliance/gmp-01.process.test.ts", content: "..." }],
 *     reason: "工艺验证测试 5 条全部通过"
 *   }
 *
 * 字段说明（架构师审查 B5-M10 修复）：
 * - severity 字段（新增）：携带规则严重性，便于 G-7-Comp-4 校验"blocker 级规则必须全部通过"
 *   原设计未携带 severity，导致 G-7-Comp-4 无法独立校验，被错误地合并到 G-7-Comp-3
 *   修复后 ComplianceEngine.run() 在生成 ComplianceRuleResult 时从 ComplianceRule.severity 复制
 *
 * 设计依据：§6.3 ComplianceRuleResult + B5-M10 修复
 */
export interface ComplianceRuleResult {
  /** 规则 ID */
  readonly ruleId: string;
  /** 是否通过 */
  readonly passed: boolean;
  /** 规则严重性（从 ComplianceRule.severity 复制，便于 G-7-Comp-4 校验） */
  readonly severity: ComplianceSeverity;
  /** 证据列表（含代码片段 / 测试输出 / 配置 / 日志 / 审计追踪） */
  readonly evidence: ReadonlyArray<ComplianceEvidence>;
  /** 判定理由（人类可读，含具体未通过项） */
  readonly reason: string;
}

/**
 * 合规证据报告（整个合规包的执行产出）
 *
 * 用于 G-7 门禁校验与 PR 描述渲染。
 *
 * 字段全部 readonly——报告一经生成即不可变。
 *
 * 范例：
 *   {
 *     packId: "GMP",
 *     runId: "a1b2c3d4e5f6",
 *     generatedAt: "2026-07-19T10:00:00.000Z",
 *     ruleResults: [{ ruleId: "GMP-01", passed: true, ... }, ...],
 *     overallPassed: true,
 *     summary: "GMP 合规包 6 条规则全部通过"
 *   }
 *
 * 设计依据：§6.3 ComplianceEvidenceReport
 */
export interface ComplianceEvidenceReport {
  /** 合规包 ID */
  readonly packId: CompliancePackId;
  /** 运行 ID（关联 RunState） */
  readonly runId: string;
  /** 生成时间（ISO 8601 字符串） */
  readonly generatedAt: string;
  /** 各规则校验结果列表 */
  readonly ruleResults: ReadonlyArray<ComplianceRuleResult>;
  /** 整体是否通过（所有 blocker / major 规则通过） */
  readonly overallPassed: boolean;
  /** 摘要（人类可读） */
  readonly summary: string;
}

// ============================================================================
// 6. 默认常量（版本与合规包名称）
// ============================================================================

/**
 * 默认合规包版本号（语义化版本）
 *
 * 用于所有 CompliancePack 实例的 version 字段，确保版本一致性。
 * 版本号遵循语义化版本规范（semver）。
 *
 * 设计依据：§6.3 CompliancePack.version 默认值
 */
export const DEFAULT_COMPLIANCE_PACK_VERSION: string = "1.0.0";

/**
 * 默认合规包名称映射（合规包 ID → 中文名称）
 *
 * 用于 CompliancePack.packName 字段的标准命名，确保各 pack 实例命名一致。
 *
 * 设计依据：§6.3 CompliancePack.packName 默认值
 */
export const DEFAULT_PACK_NAMES: Readonly<Record<CompliancePackId, string>> = Object.freeze({
  GMP: "药品生产质量管理规范（GMP）",
  CFR: "21 CFR Part 11 电子记录与电子签名",
  ALCOA: "ALCOA+ 数据完整性原则",
});

// ============================================================================
// 7. 合规检查错误类型
// ============================================================================

/**
 * 合规检查错误（ComplianceCheckError）
 *
 * 用于在合规检查器执行过程中抛出的结构化错误。
 * 携带 ruleId（出错的规则 ID）和 reason（错误原因），便于上层编排器
 * 进行错误隔离与错误归因，避免错误信息丢失。
 *
 * 继承自标准 Error，支持 cause 字段（链式错误），便于追溯原始异常。
 *
 * 使用示例：
 * ```typescript
 * try {
 *   await riskyOperation();
 * } catch (e) {
 *   throw new ComplianceCheckError("GMP-01", "工艺验证测试执行失败", e);
 * }
 * ```
 *
 * 设计依据：§6.3 错误处理策略（错误隔离 + 链式 cause）
 */
export class ComplianceCheckError extends Error {
  /** 出错的规则 ID（如 "GMP-01" / "CFR-03" / "ALCOA-05"） */
  public readonly ruleId: string;
  /** 错误原因（人类可读） */
  public readonly reason: string;

  /**
   * 构造合规检查错误
   *
   * @param ruleId 出错的规则 ID
   * @param reason 错误原因（人类可读）
   * @param cause 原始异常（可选，用于链式错误追溯）
   */
  constructor(ruleId: string, reason: string, cause?: unknown) {
    super(`[${ruleId}] ${reason}`, cause !== undefined ? { cause } : undefined);
    this.name = "ComplianceCheckError";
    this.ruleId = ruleId;
    this.reason = reason;
  }
}

// ============================================================================
// 8. 工厂函数（构造不可变实例，含输入校验）
// ============================================================================

/**
 * 构造合规证据对象（不可变实例）
 *
 * 输入校验：
 * - kind 必须为合法的 ComplianceEvidenceKind 值
 * - source 必须为非空字符串
 * - content 必须为字符串（允许空字符串）
 *
 * 返回值被 Object.freeze 冻结，确保不可变。
 *
 * @param input 证据字段输入
 * @returns 冻结的 ComplianceEvidence 实例
 * @throws 当输入非法时抛出 Error
 *
 * 设计依据：§6.3 ComplianceEvidence 工厂模式
 */
export function createComplianceEvidence(input: {
  kind: ComplianceEvidenceKind;
  source: string;
  content: string;
}): ComplianceEvidence {
  // 校验 kind
  if (!(COMPLIANCE_EVIDENCE_KINDS as readonly string[]).includes(input.kind)) {
    throw new Error(`kind 非法：${String(input.kind)}`);
  }
  // 校验 source 非空字符串
  if (typeof input.source !== "string" || input.source.length === 0) {
    throw new Error("source 必须为非空字符串");
  }
  // 校验 content 为字符串（允许空字符串）
  if (typeof input.content !== "string") {
    throw new Error("content 必须为字符串");
  }
  return Object.freeze({
    kind: input.kind,
    source: input.source,
    content: input.content,
  });
}

/**
 * 构造合规规则校验结果（不可变实例）
 *
 * 输入校验：
 * - ruleId 必须为非空字符串
 * - severity 必须为合法的 ComplianceSeverity 值
 * - evidence 必须为数组
 * - passed 必须为布尔值
 * - reason 必须为字符串
 *
 * 返回值与 evidence 字段均被 Object.freeze 冻结。
 *
 * @param input 结果字段输入
 * @returns 冻结的 ComplianceRuleResult 实例
 * @throws 当输入非法时抛出 Error
 *
 * 设计依据：§6.3 ComplianceRuleResult 工厂模式
 */
export function createComplianceRuleResult(input: {
  ruleId: string;
  passed: boolean;
  severity: ComplianceSeverity;
  evidence: ReadonlyArray<ComplianceEvidence>;
  reason: string;
}): ComplianceRuleResult {
  // 校验 ruleId 非空字符串
  if (typeof input.ruleId !== "string" || input.ruleId.length === 0) {
    throw new Error("ruleId 必须为非空字符串");
  }
  // 校验 severity 合法
  if (!(COMPLIANCE_SEVERITIES as readonly string[]).includes(input.severity)) {
    throw new Error(`severity 非法：${String(input.severity)}`);
  }
  // 校验 evidence 为数组
  if (!Array.isArray(input.evidence)) {
    throw new Error("evidence 必须为数组");
  }
  // 校验 passed 为布尔值
  if (typeof input.passed !== "boolean") {
    throw new Error("passed 必须为布尔值");
  }
  // 校验 reason 为字符串
  if (typeof input.reason !== "string") {
    throw new Error("reason 必须为字符串");
  }
  return Object.freeze({
    ruleId: input.ruleId,
    passed: input.passed,
    severity: input.severity,
    evidence: Object.freeze([...input.evidence]),
    reason: input.reason,
  });
}

/**
 * 构造合规证据报告（不可变实例）
 *
 * 输入校验：
 * - packId 必须为合法的 CompliancePackId 值
 * - runId 必须为非空字符串
 * - generatedAt 必须为非空字符串
 * - ruleResults 必须为数组
 * - overallPassed 必须为布尔值
 * - summary 必须为字符串
 *
 * 返回值与 ruleResults 字段均被 Object.freeze 冻结。
 *
 * @param input 报告字段输入
 * @returns 冻结的 ComplianceEvidenceReport 实例
 * @throws 当输入非法时抛出 Error
 *
 * 设计依据：§6.3 ComplianceEvidenceReport 工厂模式
 */
export function createComplianceEvidenceReport(input: {
  packId: CompliancePackId;
  runId: string;
  generatedAt: string;
  ruleResults: ReadonlyArray<ComplianceRuleResult>;
  overallPassed: boolean;
  summary: string;
}): ComplianceEvidenceReport {
  // 校验 packId 合法
  if (!(COMPLIANCE_PACK_IDS as readonly string[]).includes(input.packId)) {
    throw new Error(`packId 非法：${String(input.packId)}`);
  }
  // 校验 runId 非空字符串
  if (typeof input.runId !== "string" || input.runId.length === 0) {
    throw new Error("runId 必须为非空字符串");
  }
  // 校验 generatedAt 非空字符串
  if (typeof input.generatedAt !== "string" || input.generatedAt.length === 0) {
    throw new Error("generatedAt 必须为非空字符串");
  }
  // 校验 ruleResults 为数组
  if (!Array.isArray(input.ruleResults)) {
    throw new Error("ruleResults 必须为数组");
  }
  // 校验 overallPassed 为布尔值
  if (typeof input.overallPassed !== "boolean") {
    throw new Error("overallPassed 必须为布尔值");
  }
  // 校验 summary 为字符串
  if (typeof input.summary !== "string") {
    throw new Error("summary 必须为字符串");
  }
  return Object.freeze({
    packId: input.packId,
    runId: input.runId,
    generatedAt: input.generatedAt,
    ruleResults: Object.freeze([...input.ruleResults]),
    overallPassed: input.overallPassed,
    summary: input.summary,
  });
}

/**
 * 构造合规检查上下文（不可变实例）
 *
 * 输入校验：
 * - projectRoot 必须为非空字符串
 * - fileMap 必须为对象
 * - astMap 必须为对象
 * - configMap 必须为对象
 * - testRunner（可选）若提供则原样保留
 * - apiClient（可选）若提供则原样保留
 *
 * 返回值与 fileMap / astMap / configMap 字段均被 Object.freeze 冻结。
 * 注意：fileMap / astMap / configMap 内部属性不递归冻结（浅冻结），
 * 因为业务代码可能期望保留原始引用。
 *
 * @param input 上下文字段输入
 * @returns 冻结的 ComplianceCheckContext 实例
 * @throws 当输入非法时抛出 Error
 *
 * 设计依据：§6.3 ComplianceCheckContext 工厂模式
 */
export function createComplianceCheckContext(input: {
  projectRoot: string;
  fileMap: Record<string, string>;
  astMap: Record<string, unknown>;
  configMap: Record<string, unknown>;
  testRunner?: ComplianceTestRunner;
  apiClient?: ComplianceApiClient;
}): ComplianceCheckContext {
  // 校验 projectRoot 非空字符串
  if (typeof input.projectRoot !== "string" || input.projectRoot.length === 0) {
    throw new Error("projectRoot 必须为非空字符串");
  }
  // 校验 fileMap 为对象
  if (input.fileMap === null || typeof input.fileMap !== "object" || Array.isArray(input.fileMap)) {
    throw new Error("fileMap 必须为对象");
  }
  // 校验 astMap 为对象
  if (input.astMap === null || typeof input.astMap !== "object" || Array.isArray(input.astMap)) {
    throw new Error("astMap 必须为对象");
  }
  // 校验 configMap 为对象
  if (input.configMap === null || typeof input.configMap !== "object" || Array.isArray(input.configMap)) {
    throw new Error("configMap 必须为对象");
  }
  return Object.freeze({
    projectRoot: input.projectRoot,
    fileMap: Object.freeze({ ...input.fileMap }),
    astMap: Object.freeze({ ...input.astMap }),
    configMap: Object.freeze({ ...input.configMap }),
    testRunner: input.testRunner,
    apiClient: input.apiClient,
  });
}
