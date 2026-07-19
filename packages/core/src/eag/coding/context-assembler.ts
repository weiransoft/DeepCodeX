/**
 * Phase B 上下文装配器（EAG-P2 批次 9 S3 核心组件层）
 *
 * 本模块实现 `ContextAssembler` 类，对应 EAG-P2 批次 9 设计 §4.3 Phase B 上下文装配器：
 * 将 PKC L1/L2/L3 + TCS 规范 + RLIS 规则 + 企业红线 + 当前任务卡 + 模块切分装配为
 * 单一 `CodingContext` 不可变对象，供 Phase B LLM 填充与 STRICT 评估器共用。
 *
 * 核心职责（对齐 §4.3.1）：
 * 1. 从 fileCluster（来自 TaskNode.fileCluster，由调用方传入）提取查询关键词
 * 2. 调用 pkcAccessor.searchL2(query, topK=10) 获取相关符号
 * 3. 调用 pkcAccessor.queryL1GlobalView() 获取模块聚类
 * 4. 调用 pkcAccessor.queryL3BusinessKnowledge() 获取业务流程 + ER 图
 * 5. 从 planContent 解析当前任务卡对应的 ModuleSplit（复用 PlanParser.parseModuleSplit）
 * 6. 调用 ruleStore.getEffectiveRules() 获取 RLIS 生效规则
 * 7. 将 UserRule 列表转换为 RlisRuleSummary 列表（含 severity 大写→小写转换）
 * 8. 将 TCS_REDLINES 按 componentId 分组为 TcsSpecSummary 列表
 * 9. 返回冻结的 CodingContext
 *
 * 设计依据：
 * - EAG-P2 批次 9 设计 §4.3.1 职责
 * - §4.3.2 核心类设计
 * - §4.3.3 plan.md 解析（复用 skeleton-generator 的 PlanParser）
 * - §7 R7 风险缓解：L2 语义检索结果按 score 排序仅取 Top-5；score < 0.5 过滤
 *
 * 与设计文档的偏差说明（真实实现需求）：
 * - 设计文档算法第 1 步写"从 taskCard.fileCluster 提取查询关键词"，
 *   但 TaskCard 类型（doc-driven/types.ts）不含 fileCluster 字段（该字段在 TaskNode 上）。
 *   且本批次硬约束禁止修改 S1/S2 已创建文件（含 doc-driven/types.ts）。
 *   修复方式：将 fileCluster 作为 assemble() 方法的显式参数传入，
 *   由调用方（CodingOrchestrator）从 taskDag.nodes 查找 TaskNode.fileCluster 后传入。
 * - 设计文档算法第 6 步写"调用 ruleInjector.getEffectiveRules()"，
 *   但 RuleInjector 类（rlis/rule-injector.ts）不含 getEffectiveRules 方法
 *   （该方法在 RuleStore 类上）。修复方式：使用 RuleStore 而非 RuleInjector。
 *
 * 不可变优先原则（对齐 §5.12.4 G-A6d）：
 * - 所有方法入参与返回值使用 readonly + ReadonlyArray
 * - 顶层配置使用 Object.freeze 冻结
 * - 装配产出 CodingContext 通过 Object.freeze 冻结
 *
 * @module eag/coding/context-assembler
 */

import type { CodingContext, PkcAccessor, RlisRuleSummary, SemanticSearchHit, TcsSpecSummary } from "./types";
import type { RedlineDefinition } from "../evaluator/types";
import type { TaskCard, ModuleSplit } from "../doc-driven/types";
import { PlanParser } from "./skeleton-generator";
import { ENTERPRISE_REDLINES } from "../redlines/enterprise-rules";
import { TCS_REDLINES } from "../tcs/tcs-redlines";
import { RuleStore } from "../rlis/rule-store";
import { SEED_RULES } from "../rlis/seed-rules";
import type { UserRule } from "../rlis/types";

// ============================================================================
// 常量与配置
// ============================================================================

/**
 * L2 语义检索默认 Top-K
 *
 * 对齐 §4.3.2 算法第 2 步："调用 pkcAccessor.searchL2(query, topK=10)"。
 * 数值依据：从 PKC L2 索引中取 Top-10 命中项，再由本装配器按 score 排序后取 Top-5。
 */
const L2_SEARCH_TOP_K = 10 as const;

/**
 * L2 语义检索结果保留的 Top-N
 *
 * 对齐 §7 R7 风险缓解："ContextAssembler 对 L2 结果按 score 排序，仅取 Top-5"。
 * 数值依据：Top-5 既能覆盖最相关的代码符号，又避免上下文 token 膨胀。
 */
const L2_KEEP_TOP_N = 5 as const;

/**
 * L2 score 过滤阈值
 *
 * 对齐 §7 R7 风险缓解："score < 0.5 的命中项过滤掉"。
 * 数值依据：score < 0.5 表示相关性较低，引入会带来噪声而非信号。
 */
const L2_SCORE_THRESHOLD = 0.5 as const;

/**
 * TCS 红线 ID 到 componentId 的映射
 *
 * TCS_REDLINES 中的红线 ID 形如 "TCS-CACHE-01" / "TCS-OSS-02"，
 * 取前两段（"TCS-CACHE" / "TCS-OSS"）作为 componentId。
 * 此函数封装该前缀提取逻辑。
 *
 * @param redlineId TCS 红线 ID（如 "TCS-CACHE-01"）
 * @returns componentId（如 "TCS-CACHE"）；非 TCS 红线返回 null
 */
function extractComponentId(redlineId: string): string | null {
  const match = redlineId.match(/^(TCS-[A-Z]+)-\d+$/);
  return match ? match[1] : null;
}

/**
 * TCS 各组件的 Port 接口字符串
 *
 * 对齐 §4.1.2 TcsSpecSummary.portInterface：每个 TcsSpecSummary 应携带
 * 该组件的 Port 接口定义字符串，供 LLM 填充时参考组件接口契约。
 *
 * 接口内容严格对齐 `eag/tcs/` 模块中实际定义的 Port 接口：
 * - TCS-CACHE：CachePort（cache.ts 第 404 行）
 * - TCS-OSS：ObjectStoragePort（object-storage.ts 第 164 行）
 * - TCS-SQL：SqlOptimizationPort（sql-optimizer.ts 第 103 行）
 * - TCS-LDAP：LdapSyncPort（ldap-adapter.ts 第 230 行）
 * - TCS-SEC：VulnerabilityScanPort（vulnerability-scanner.ts 第 126 行）
 *
 * 此处以字符串形式内嵌 Port 接口签名（仅方法签名，不含实现），
 * 便于直接注入到 LLM system prompt 而无需运行期反射或动态加载。
 */
const TCS_PORT_INTERFACES: Readonly<Record<string, string>> = Object.freeze({
  "TCS-CACHE": [
    "interface CachePort {",
    "  get<T>(keyParams: CacheKeyParams): Promise<CacheGetResult<T>>;",
    "  set<T>(keyParams: CacheKeyParams, value: T | null, options: CacheSetOptions): Promise<void>;",
    "  delete(keyParams: CacheKeyParams): Promise<void>;",
    "  getWithRebuild<T>(",
    "    keyParams: CacheKeyParams,",
    "    loader: () => Promise<T | null>,",
    "    options: CacheSetOptions",
    "  ): Promise<CacheGetResult<T>>;",
    "  doubleWrite<T>(keyParams: CacheKeyParams, dbUpdater: () => Promise<T>): Promise<CacheDoubleWriteResult>;",
    "}",
  ].join("\n"),
  "TCS-OSS": [
    "interface ObjectStoragePort {",
    "  put(",
    "    content: Buffer | string,",
    "    keyParams: StorageKeyParams,",
    "    options?: PutOptions",
    "  ): Promise<PutResult>;",
    "  get(key: string): Promise<GetResult>;",
    "  delete(key: string): Promise<DeleteResult>;",
    "  signedUrl(",
    "    key: string,",
    "    expiresInSeconds?: number,",
    '    method?: "GET" | "PUT"',
    "  ): Promise<SignedUrlResult>;",
    "  multipartUpload(",
    "    content: Buffer | string,",
    "    keyParams: StorageKeyParams,",
    "    options?: MultipartOptions",
    "  ): Promise<MultipartResult>;",
    "}",
  ].join("\n"),
  "TCS-SQL": [
    "interface SqlOptimizationPort {",
    "  reviewIndexes(input: IndexReviewInput): Promise<IndexReviewResult>;",
    "  detectNPlusOne(queries: Array<{ sql: string; params: unknown[] }>): Promise<NPlusOneDetectionResult>;",
    "  checkPagination(offset: number, limit: number): Promise<PaginationCheckResult>;",
    "}",
  ].join("\n"),
  "TCS-LDAP": [
    "interface LdapSyncPort {",
    "  syncUsers(): Promise<LdapSyncResult>;",
    "  syncOrgs(): Promise<LdapSyncResult>;",
    "  queryUserByDn(dn: string): Promise<LdapUserEntry | null>;",
    "}",
  ].join("\n"),
  "TCS-SEC": [
    "interface VulnerabilityScanPort {",
    "  scanDependencies(): Promise<VulnerabilityScanReport>;",
    "  scanHardcodedSecrets(",
    "    files: Array<{ path: string; content: string }>",
    "  ): Promise<Array<VulnerabilityFinding>>;",
    "}",
  ].join("\n"),
});

// ============================================================================
// 异常类型
// ============================================================================

/**
 * 上下文装配器错误
 *
 * 当 PKC 访问失败、plan.md 解析失败、fileCluster 缺失等场景抛出。
 */
export class ContextAssemblerError extends Error {
  /**
   * @param kind 错误类型
   *   - invalid-argument：参数非法（taskCard / planContent / projectRoot / fileCluster 为空）
   *   - pkc-access-failed：PKC 访问失败（L1/L2/L3 查询抛错）
   *   - module-split-not-found：plan.md 中找不到 fileCluster 对应的 ModuleSplit
   *   - rule-store-unavailable：RuleStore 不可用或获取规则失败
   * @param detail 错误详情
   */
  constructor(
    public readonly kind:
      | "invalid-argument"
      | "pkc-access-failed"
      | "module-split-not-found"
      | "rule-store-unavailable",
    public readonly detail: string
  ) {
    super(`上下文装配器错误 [${kind}]：${detail}`);
    this.name = "ContextAssemblerError";
  }
}

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 将 RLIS UserRule 列表转换为 RlisRuleSummary 列表
 *
 * 转换规则：
 * - rule.id → summary.ruleId
 * - rule.category → summary.category（直接传递字符串）
 * - rule.severity → summary.severity（大写转小写：BLOCKER→blocker / MAJOR→major / WARNING→warning）
 *   对齐 RlisRuleSummary.severity 注释"对齐 RedlineSeverity：blocker / major / warning"
 * - rule.content → summary.content
 *
 * @param rules RLIS UserRule 列表
 * @returns RlisRuleSummary 列表（已冻结）
 */
function convertRulesToSummaries(rules: ReadonlyArray<UserRule>): ReadonlyArray<RlisRuleSummary> {
  const summaries: RlisRuleSummary[] = rules.map((rule) => {
    // severity 大写 → 小写（对齐 RedlineSeverity）
    const severityLower = rule.severity.toLowerCase();
    return Object.freeze({
      ruleId: rule.id,
      category: rule.category,
      severity: severityLower,
      content: rule.content,
    }) as RlisRuleSummary;
  });
  return Object.freeze(summaries);
}

/**
 * 将 TCS_REDLINES 按 componentId 分组为 TcsSpecSummary 列表
 *
 * 分组算法：
 * 1. 遍历 TCS_REDLINES，每条红线按 ID 提取 componentId（如 "TCS-CACHE-01" → "TCS-CACHE"）
 * 2. 按 componentId 聚合红线
 * 3. 为每个 componentId 构建 TcsSpecSummary（含 portInterface 从 TCS_PORT_INTERFACES 查询）
 * 4. 按 componentId 字母序排序（保证测试可重现）
 *
 * @param tcsRedlines TCS 红线清单（默认为 TCS_REDLINES）
 * @returns TcsSpecSummary 列表（已冻结）
 */
function buildTcsSpecSummaries(tcsRedlines: ReadonlyArray<RedlineDefinition>): ReadonlyArray<TcsSpecSummary> {
  // 1. 按 componentId 分组
  const groups = new Map<string, RedlineDefinition[]>();
  for (const redline of tcsRedlines) {
    const componentId = extractComponentId(redline.id);
    if (!componentId) continue;
    const list = groups.get(componentId);
    if (list) {
      list.push(redline);
    } else {
      groups.set(componentId, [redline]);
    }
  }

  // 2. 构建 TcsSpecSummary 列表
  const summaries: TcsSpecSummary[] = [];
  for (const [componentId, redlines] of groups) {
    const portInterface = TCS_PORT_INTERFACES[componentId] ?? "";
    summaries.push(
      Object.freeze({
        componentId,
        portInterface,
        redlines: Object.freeze([...redlines]) as ReadonlyArray<RedlineDefinition>,
      }) as TcsSpecSummary
    );
  }

  // 3. 按 componentId 字母序排序（保证测试可重现）
  summaries.sort((a, b) => a.componentId.localeCompare(b.componentId));

  return Object.freeze(summaries);
}

/**
 * 对 L2 语义检索结果进行过滤与排序
 *
 * 算法（对齐 §7 R7 风险缓解）：
 * 1. 过滤 score < L2_SCORE_THRESHOLD 的命中项
 * 2. 按 score 降序排序
 * 3. 仅保留 Top-N（L2_KEEP_TOP_N）
 *
 * @param hits L2 语义检索原始命中项
 * @returns 过滤+排序+截断后的命中项列表（已冻结）
 */
function filterAndRankL2Hits(hits: ReadonlyArray<SemanticSearchHit>): ReadonlyArray<SemanticSearchHit> {
  // 1. 过滤低 score 命中项
  const filtered = hits.filter((h) => h.score >= L2_SCORE_THRESHOLD);

  // 2. 按 score 降序排序（稳定排序，score 相同时按 symbolId 字母序保证可重现）
  const sorted = [...filtered].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.symbolId.localeCompare(b.symbolId);
  });

  // 3. 截断为 Top-N
  const topN = sorted.slice(0, L2_KEEP_TOP_N);

  return Object.freeze(topN) as ReadonlyArray<SemanticSearchHit>;
}

// ============================================================================
// ContextAssembler 类
// ============================================================================

/**
 * Phase B 上下文装配器
 *
 * 对应 EAG-P2 批次 9 设计 §4.3.2 ContextAssembler：
 * 将 PKC + TCS + RLIS + 红线 + 任务卡 + 模块切分装配为单一 CodingContext。
 *
 * 使用方式：
 * ```typescript
 * const assembler = new ContextAssembler(pkcAccessor);
 * const context = await assembler.assemble(
 *   taskCard,
 *   planContent,
 *   projectRoot,
 *   fileCluster  // 来自 TaskNode.fileCluster，由调用方查找后传入
 * );
 * // context.l1GlobalView / l2SemanticResults / l3BusinessKnowledge 等字段已就绪
 * ```
 *
 * 不可变优先：
 * - 构造时注入的依赖（pkcAccessor / redlines / ruleStore）使用 readonly 包裹
 * - assemble() 返回的 CodingContext 通过 Object.freeze 冻结
 * - 所有辅助函数返回 ReadonlyArray / readonly 字段
 */
export class ContextAssembler {
  /**
   * PKC 知识库访问器（L1/L2/L3 查询接口）
   *
   * 由调用方注入具体实现：
   * - 生产环境：真实 PKC 访问器（含向量检索 + 模块聚类）
   * - 测试场景：InMemoryPkcAccessor（真实实现，非 mock）
   */
  private readonly pkcAccessor: PkcAccessor;

  /**
   * TCS 红线清单（用于派生 TcsSpecSummary 列表）
   *
   * 默认为 TCS_REDLINES（13 条），调用方可注入项目特有的红线清单。
   */
  private readonly tcsRedlines: ReadonlyArray<RedlineDefinition>;

  /**
   * 企业红线清单（E1~E8）
   *
   * 默认为 ENTERPRISE_REDLINES，调用方可注入项目特有的红线清单。
   */
  private readonly enterpriseRedlines: ReadonlyArray<RedlineDefinition>;

  /**
   * RLIS 三层规则存储器
   *
   * 提供 getEffectiveRules() 方法返回合并后的生效规则列表。
   * 默认为 new RuleStore(SEED_RULES)，调用方可注入含项目层规则的 RuleStore。
   */
  private readonly ruleStore: RuleStore;

  /**
   * 日志回调（可选，用于输出调试信息）
   */
  private readonly logger?: (message: string, level?: "info" | "warn" | "error") => void;

  /**
   * 预构建的 TcsSpecSummary 列表（构造时一次性构建，避免每次 assemble 重复构建）
   *
   * 由于 tcsRedlines 在构造后不可变，可在构造时预构建 TcsSpecSummary 列表，
   * 多次 assemble 调用共享同一份 TcsSpecSummary 列表。
   */
  private readonly tcsSpecsCache: ReadonlyArray<TcsSpecSummary>;

  /**
   * 初始化上下文装配器
   *
   * @param pkcAccessor PKC 知识库访问器（必填）
   * @param tcsRedlines TCS 红线清单（默认 TCS_REDLINES）
   * @param enterpriseRedlines 企业红线清单（默认 ENTERPRISE_REDLINES）
   * @param ruleStore RLIS 规则存储器（默认 new RuleStore(SEED_RULES)）
   * @param logger 日志回调（可选）
   */
  constructor(
    pkcAccessor: PkcAccessor,
    tcsRedlines: ReadonlyArray<RedlineDefinition> = TCS_REDLINES,
    enterpriseRedlines: ReadonlyArray<RedlineDefinition> = ENTERPRISE_REDLINES,
    ruleStore: RuleStore = new RuleStore(SEED_RULES),
    logger?: (message: string, level?: "info" | "warn" | "error") => void
  ) {
    this.pkcAccessor = pkcAccessor;
    this.tcsRedlines = tcsRedlines;
    this.enterpriseRedlines = enterpriseRedlines;
    this.ruleStore = ruleStore;
    this.logger = logger;
    // 预构建 TcsSpecSummary 列表（tcsRedlines 不可变，可安全缓存）
    this.tcsSpecsCache = buildTcsSpecSummaries(this.tcsRedlines);
  }

  /**
   * 装配 CODING Loop 上下文
   *
   * 算法（对齐 §4.3.2）：
   * 1. 校验入参合法性（taskCard / planContent / projectRoot / fileCluster 非空）
   * 2. 调用 pkcAccessor.searchL2(fileCluster, topK=10) 获取相关符号
   * 3. 调用 pkcAccessor.queryL1GlobalView(projectRoot) 获取模块聚类
   * 4. 调用 pkcAccessor.queryL3BusinessKnowledge(projectRoot) 获取业务流程 + ER 图
   * 5. 从 planContent 解析当前 fileCluster 对应的 ModuleSplit
   * 6. 调用 ruleStore.getEffectiveRules() 获取 RLIS 生效规则并转换为 RlisRuleSummary
   * 7. 对 L2 命中项按 score 过滤+排序+截断 Top-5（§7 R7 风险缓解）
   * 8. 组装并返回冻结的 CodingContext
   *
   * @param taskCard 当前任务卡
   * @param planContent plan.md 内容字符串
   * @param projectRoot 项目根目录（绝对路径）
   * @param fileCluster 任务卡所属文件簇名（来自 TaskNode.fileCluster）
   * @returns 冻结的 CodingContext
   * @throws {ContextAssemblerError} 入参非法 / PKC 访问失败 / ModuleSplit 未找到
   */
  async assemble(
    taskCard: Readonly<TaskCard>,
    planContent: string,
    projectRoot: string,
    fileCluster: string
  ): Promise<Readonly<CodingContext>> {
    this.logger?.("ContextAssembler.assemble 启动", "info");
    const startTime = Date.now();

    // 步骤 1：校验入参合法性
    this.validateArguments(taskCard, planContent, projectRoot, fileCluster);

    // 步骤 2：调用 PKC L2 语义检索（使用 fileCluster 作为查询关键词）
    let l2Hits: ReadonlyArray<SemanticSearchHit>;
    try {
      this.logger?.(`调用 pkcAccessor.searchL2(query="${fileCluster}", topK=${L2_SEARCH_TOP_K})`, "info");
      l2Hits = await this.pkcAccessor.searchL2(fileCluster, projectRoot, L2_SEARCH_TOP_K);
    } catch (e) {
      throw new ContextAssemblerError(
        "pkc-access-failed",
        `pkcAccessor.searchL2 调用失败：${e instanceof Error ? e.message : String(e)}`
      );
    }

    // 步骤 3：调用 PKC L1 全局视野查询
    let l1GlobalView: Readonly<Record<string, unknown>>;
    try {
      this.logger?.(`调用 pkcAccessor.queryL1GlobalView(projectRoot="${projectRoot}")`, "info");
      l1GlobalView = await this.pkcAccessor.queryL1GlobalView(projectRoot);
    } catch (e) {
      throw new ContextAssemblerError(
        "pkc-access-failed",
        `pkcAccessor.queryL1GlobalView 调用失败：${e instanceof Error ? e.message : String(e)}`
      );
    }

    // 步骤 4：调用 PKC L3 业务知识查询
    let l3BusinessKnowledge: Readonly<Record<string, unknown>>;
    try {
      this.logger?.(`调用 pkcAccessor.queryL3BusinessKnowledge(projectRoot="${projectRoot}")`, "info");
      l3BusinessKnowledge = await this.pkcAccessor.queryL3BusinessKnowledge(projectRoot);
    } catch (e) {
      throw new ContextAssemblerError(
        "pkc-access-failed",
        `pkcAccessor.queryL3BusinessKnowledge 调用失败：${e instanceof Error ? e.message : String(e)}`
      );
    }

    // 步骤 5：从 planContent 解析当前 fileCluster 对应的 ModuleSplit
    const moduleSplit: ModuleSplit | null = PlanParser.parseModuleSplit(planContent, fileCluster);
    if (!moduleSplit) {
      throw new ContextAssemblerError(
        "module-split-not-found",
        `plan.md 中未找到 moduleName="${fileCluster}" 的 ModuleSplit`
      );
    }

    // 步骤 6：获取 RLIS 生效规则并转换为 RlisRuleSummary
    let effectiveRules: ReadonlyArray<UserRule>;
    try {
      effectiveRules = this.ruleStore.getEffectiveRules();
    } catch (e) {
      throw new ContextAssemblerError(
        "rule-store-unavailable",
        `ruleStore.getEffectiveRules 调用失败：${e instanceof Error ? e.message : String(e)}`
      );
    }
    const rlisRules = convertRulesToSummaries(effectiveRules);

    // 步骤 7：对 L2 命中项过滤+排序+截断 Top-5（§7 R7 风险缓解）
    const filteredL2Hits = filterAndRankL2Hits(l2Hits);
    this.logger?.(
      `L2 命中项：原始 ${l2Hits.length} 条，过滤后 ${filteredL2Hits.length} 条（阈值 ${L2_SCORE_THRESHOLD}，Top-${L2_KEEP_TOP_N}）`,
      "info"
    );

    // 步骤 8：组装并返回冻结的 CodingContext
    const durationMs = Date.now() - startTime;
    this.logger?.(`ContextAssembler.assemble 完成，耗时 ${durationMs}ms`, "info");

    const context: CodingContext = {
      l1GlobalView,
      l2SemanticResults: filteredL2Hits,
      l3BusinessKnowledge,
      tcsSpecs: this.tcsSpecsCache,
      rlisRules,
      enterpriseRedlines: this.enterpriseRedlines,
      taskCard,
      moduleSplit,
    };

    return Object.freeze(context) as Readonly<CodingContext>;
  }

  // ========================================================================
  // 公共 API：便捷查询
  // ========================================================================

  /**
   * 获取预构建的 TcsSpecSummary 列表
   *
   * 由于 TcsSpecSummary 仅依赖 tcsRedlines（构造时确定），可安全暴露给外部访问。
   * 用于调用方在不触发完整 assemble 流程时获取 TCS 规范摘要。
   *
   * @returns TcsSpecSummary 列表（已冻结）
   */
  getTcsSpecs(): ReadonlyArray<TcsSpecSummary> {
    return this.tcsSpecsCache;
  }

  /**
   * 获取企业红线清单
   *
   * @returns 企业红线清单（E1~E8）
   */
  getEnterpriseRedlines(): ReadonlyArray<RedlineDefinition> {
    return this.enterpriseRedlines;
  }

  /**
   * 获取 RLIS 生效规则列表
   *
   * 委托 ruleStore.getEffectiveRules() 返回合并后的生效规则列表。
   *
   * @returns RLIS 生效规则列表
   */
  getEffectiveRlisRules(): ReadonlyArray<UserRule> {
    return this.ruleStore.getEffectiveRules();
  }

  // ========================================================================
  // 私有辅助方法
  // ========================================================================

  /**
   * 校验 assemble 方法入参合法性
   *
   * 校验规则：
   * - taskCard 必须含非空 id / requirementId
   * - planContent 必须为非空字符串
   * - projectRoot 必须为非空字符串
   * - fileCluster 必须为非空字符串
   *
   * @param taskCard 任务卡
   * @param planContent plan.md 内容
   * @param projectRoot 项目根目录
   * @param fileCluster 文件簇名
   * @throws {ContextAssemblerError} 任一字段非法时抛出
   */
  private validateArguments(
    taskCard: Readonly<TaskCard>,
    planContent: string,
    projectRoot: string,
    fileCluster: string
  ): void {
    if (!taskCard || typeof taskCard.id !== "string" || taskCard.id.trim().length === 0) {
      throw new ContextAssemblerError("invalid-argument", "taskCard.id 必须为非空字符串");
    }
    if (typeof taskCard.requirementId !== "string" || taskCard.requirementId.trim().length === 0) {
      throw new ContextAssemblerError("invalid-argument", "taskCard.requirementId 必须为非空字符串");
    }
    if (typeof planContent !== "string" || planContent.trim().length === 0) {
      throw new ContextAssemblerError("invalid-argument", "planContent 必须为非空字符串");
    }
    if (typeof projectRoot !== "string" || projectRoot.trim().length === 0) {
      throw new ContextAssemblerError("invalid-argument", "projectRoot 必须为非空字符串");
    }
    if (typeof fileCluster !== "string" || fileCluster.trim().length === 0) {
      throw new ContextAssemblerError("invalid-argument", "fileCluster 必须为非空字符串");
    }
  }
}
