/**
 * DESIGN Loop 评估器实现（EAG-P1 批次 3）
 *
 * 本模块实现 `StaticDesignEvaluator` 类（implement DesignEvaluatorProtocol），
 * 提供 DESIGN Loop §5.2.2 评估器判定的真实逻辑（禁止 mock）。
 *
 * 判定项（对齐 §5.2.2 评估器判定）：
 * 1. **范式一致性**：架构师产出的 layering/dependencyRules 必须与所选 paradigm 的 dependencyRules 一致
 *    - 检查 architectureDocument.dependencyRules 是否与 paradigm.dependencyRules 完全一致（按 id 比对）
 *    - 检查 architectureDocument.layering 是否覆盖 paradigm.dependencyRules 涉及的全部层
 * 2. **设计完整性**：每个 UserStory 必须有至少一个 Aggregate 承载
 *    - 聚合名出现在 userStory 关联的 domainEventCandidates 的 publisher 中
 *    - 即：userStory.domainEventCandidates 中的事件名必须能在 domainModelDocument.domainEvents
 *      找到对应事件，且该事件的 publisher 是 domainModelDocument.aggregates 中的某个聚合
 * 3. **反模式零命中**：架构师产出的设计文档不得违反范式 antiPatterns 的静态可判规则
 *    - 遍历 paradigm.antiPatterns，对 detection="static" 的反模式逐条判定
 *    - 额外对 detection="reasoning" 但在 STATIC_ANTI_PATTERN_CHECKERS 表中注册了
 *      判定函数的反模式进行静态判定（基于设计文档可观察特征降级为静态可判，
 *      如 CQRS-ES 的 AP-AGG-MUT-01 通过聚合 publishedEvents 字段可静态观察）
 *    - 每条可判反模式按其 ID 派发到对应的判定函数（基于 layering/boundedContexts/aggregates 内容）
 * 4. **signalEvidence 证据强制**：自主选择范式时（非锁定）signalEvidence 必须非空且引用需求原文
 *    - 调用方传入 paradigmLock 参数指示是否锁定
 *    - 非锁定时检查 architectureDocument.signalEvidence 是否非空（至少 1 个维度）
 *
 * 评估模式（DesignLoopConfig.evaluationMode）：
 * - strict：任一判定项失败即打回（默认）
 * - lenient：仅 blocker 级问题打回，major/warning 仅记录到 findings 不影响 passed
 *
 * 输出 DesignEvaluationVerdict（passed/reason/severity/findings/suggestedFix）。
 *
 * 接口迁移说明（2026-08-19 如实修正）：
 * - 原 `design-protocols.ts` 中定义的 `DesignEvaluatorProtocol` 接口已迁移至本文件
 *   （DesignEvaluatorProtocol 仅有 StaticDesignEvaluator 一个生产实现，迁移后与实现同文件）
 * - `design-protocols.ts` 文件仍存在（定义 PM/Architect 协议，被 design-orchestrator.ts
 *   与 3 个测试文件消费），并非已删除；PM/Architect 协议无生产实现，
 *   接线债务由 optimization-plan-20260819 S3.2 跟踪
 *
 * @module eag/design/evaluator
 */

import type { ArchitectureParadigm, AntiPattern } from "../eak/types";
import type {
  DesignArtifacts,
  DesignEvaluationVerdict,
  DesignVerdictSeverity,
  DesignEvaluationMode,
} from "./design-models";

// ============================================================================
// DESIGN Loop 评估器协议接口（从 design-protocols.ts 迁移而来）
// ============================================================================
//
// 迁移原因（2026-08-19 如实修正）：
// - design-protocols.ts 中仅 DesignEvaluatorProtocol 有生产实现（StaticDesignEvaluator）
// - 将 DesignEvaluatorProtocol 迁移至其唯一实现所在文件，与 StaticDesignEvaluator 共置
// - design-protocols.ts 文件仍存在（PM/Architect 协议被 design-orchestrator.ts 与
//   3 个测试文件消费，未删除）；PM/Architect 无生产实现，
//   接线债务由 optimization-plan-20260819 S3.2 跟踪
//
// 协议设计原则（保留原 design-protocols.ts 风格）：
// - 协议为 TS interface，实现方通过结构子类型匹配，无需显式 implements
// - 协议仅描述对外契约，不约束内部实现
// - 异步接口（Promise）以适配未来真实 LLM 调用场景

/**
 * DESIGN Loop 评估器协议：设计产出 → 评估判定
 *
 * 对应 EAG 方案 §5.2.2 评估器判定 + §5.3 独立评估器角色：
 * - 唤起知识：红线清单（E1~E8）+ 依赖规则 + 客观指标
 * - 产出契约：EvaluationVerdict（passed/reason/severity）
 *
 * 判定项（对齐 §5.2.2 评估器判定）：
 * 1. 范式一致性：架构师产出的 layering/dependencyRules 必须与所选 paradigm 的 dependencyRules 一致
 * 2. 设计完整性：每个 UserStory 必须有至少一个 Aggregate 承载
 *    （聚合名出现在 userStory 关联的 domainEventCandidates 的 publisher 中）
 * 3. 反模式零命中：架构师产出的 Aggregate/Entity 不得违反范式 antiPatterns 的静态可判规则
 * 4. signalEvidence 证据强制：自主选择范式时（非锁定）signalEvidence 必须非空且引用需求原文
 *
 * 与 Generator/Evaluator 分离原则（§5.2.1）：
 * - 架构师是 Generator 角色（产出设计文档），不得自行评估
 * - 本协议由独立评估器实现，对架构师产出做客观判定
 */
export interface DesignEvaluatorProtocol {
  /**
   * 对设计产出进行独立评估并返回判定
   *
   * @param artifacts 设计产出（PM 产出 + 架构师产出）
   * @param paradigm 选中的范式定义（评估器据此判定范式一致性）
   * @returns 评估判定结果（passed/reason/severity/findings/suggestedFix）
   */
  evaluate(artifacts: DesignArtifacts, paradigm: ArchitectureParadigm): Promise<DesignEvaluationVerdict>;
}

// ============================================================================
// 严重级别优先级辅助
// ============================================================================

/**
 * 严重级别优先级映射（数值越大越严重）
 *
 * 用于在多条 finding 中取最高严重级别作为 verdict.severity。
 */
const SEVERITY_RANK: Readonly<Record<DesignVerdictSeverity, number>> = Object.freeze({
  warning: 1,
  major: 2,
  blocker: 3,
});

/**
 * 取两个严重级别中更严重的一个
 *
 * @param a 严重级别 A
 * @param b 严重级别 B
 * @returns 更严重的级别
 */
function maxSeverity(a: DesignVerdictSeverity, b: DesignVerdictSeverity): DesignVerdictSeverity {
  return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b;
}

// ============================================================================
// 静态反模式判定函数表
// ============================================================================

/**
 * 静态反模式判定函数类型
 *
 * 每个判定函数接收 DesignArtifacts 与 ArchitectureParadigm，返回命中描述列表。
 * 空列表表示未命中，非空列表表示命中（每条描述一次违反）。
 */
type StaticAntiPatternChecker = (artifacts: DesignArtifacts, paradigm: ArchitectureParadigm) => string[];

/**
 * 静态反模式判定函数表（按反模式 ID 索引）
 *
 * 表驱动设计：每条静态可判反模式对应一个判定函数，
 * 评估器遍历 paradigm.antiPatterns，对 detection="static" 的反模式按 ID 派发。
 *
 * 判定逻辑均基于设计文档可观察特征（layering.allowedDependencies / boundedContexts.responsibility），
 * 不依赖代码层分析（design 阶段无代码产出）。
 */
const STATIC_ANTI_PATTERN_CHECKERS: Readonly<Record<string, StaticAntiPatternChecker>> = Object.freeze({
  /**
   * AP-DOM-ORM-01: domain-depends-on-orm（DDD 范式）
   *
   * 判定：domain 层的 allowedDependencies 不得包含 "infrastructure"。
   * 触发：domain 层声明允许依赖 infrastructure，意味着领域层可被 ORM 绑架。
   */
  "AP-DOM-ORM-01": (artifacts) => {
    const findings: string[] = [];
    const arch = artifacts.architectureDocument;
    for (const layer of arch.layering) {
      if (layer.name === "domain" && layer.allowedDependencies.includes("infrastructure")) {
        findings.push(
          `AP-DOM-ORM-01 命中：domain 层 allowedDependencies 包含 infrastructure，` +
            `领域层可能依赖 ORM 框架（违反 domain 层零外部依赖原则）。` +
            `层职责：${layer.responsibility}`
        );
      }
    }
    return findings;
  },

  /**
   * AP-REPO-DOM-01: repository-in-application-layer（DDD 范式）
   *
   * 判定：application 层的 responsibility 不得包含 "仓储" / "Repository" 关键词。
   * 触发：仓储接口应定义在 domain 层，放在 application 层违反依赖反转。
   */
  "AP-REPO-DOM-01": (artifacts) => {
    const findings: string[] = [];
    const arch = artifacts.architectureDocument;
    for (const layer of arch.layering) {
      if (
        layer.name === "application" &&
        (layer.responsibility.includes("仓储") || layer.responsibility.includes("Repository"))
      ) {
        findings.push(
          `AP-REPO-DOM-01 命中：application 层 responsibility 包含仓储/Repository 关键词，` +
            `仓储接口应定义在 domain 层（依赖反转原则）。` +
            `层职责：${layer.responsibility}`
        );
      }
    }
    return findings;
  },

  /**
   * AP-ENT-FRAMEWORK-01: entity-depends-on-framework（Clean Architecture 范式）
   *
   * 判定：entities 层的 allowedDependencies 不得包含 "frameworks"。
   * 触发：entities 层声明允许依赖 frameworks，实体可能被框架装饰器绑架。
   */
  "AP-ENT-FRAMEWORK-01": (artifacts) => {
    const findings: string[] = [];
    const arch = artifacts.architectureDocument;
    for (const layer of arch.layering) {
      if (layer.name === "entities" && layer.allowedDependencies.includes("frameworks")) {
        findings.push(
          `AP-ENT-FRAMEWORK-01 命中：entities 层 allowedDependencies 包含 frameworks，` +
            `实体层可能依赖框架装饰器（违反 entities 零外部依赖原则）。` +
            `层职责：${layer.responsibility}`
        );
      }
    }
    return findings;
  },

  /**
   * AP-UC-DI-01: use-case-directly-instantiates-repository（Clean Architecture 范式）
   *
   * 判定：use-cases 层的 allowedDependencies 不得包含 "frameworks"。
   * 触发：use-cases 层声明允许依赖 frameworks，用例可能直接 new RepositoryImpl。
   */
  "AP-UC-DI-01": (artifacts) => {
    const findings: string[] = [];
    const arch = artifacts.architectureDocument;
    for (const layer of arch.layering) {
      if (layer.name === "use-cases" && layer.allowedDependencies.includes("frameworks")) {
        findings.push(
          `AP-UC-DI-01 命中：use-cases 层 allowedDependencies 包含 frameworks，` +
            `用例可能直接实例化框架层仓储实现（违反依赖反转与单一职责）。` +
            `层职责：${layer.responsibility}`
        );
      }
    }
    return findings;
  },

  /**
   * AP-BYPASS-ADP-01: framework-bypasses-adapter（Clean Architecture 范式）
   *
   * 判定：frameworks 层的 allowedDependencies 不得包含 "use-cases"。
   * 触发：frameworks 层声明允许直接依赖 use-cases，绕过 adapters 层的请求转换。
   */
  "AP-BYPASS-ADP-01": (artifacts) => {
    const findings: string[] = [];
    const arch = artifacts.architectureDocument;
    for (const layer of arch.layering) {
      if (layer.name === "frameworks" && layer.allowedDependencies.includes("use-cases")) {
        findings.push(
          `AP-BYPASS-ADP-01 命中：frameworks 层 allowedDependencies 包含 use-cases，` +
            `框架层可能绕过 adapters 层直接调用用例（破坏分层隔离）。` +
            `层职责：${layer.responsibility}`
        );
      }
    }
    return findings;
  },

  /**
   * AP-CMD-QUERY-01: command-side-direct-query（CQRS-ES 范式）
   *
   * 判定：command-side 层的 allowedDependencies 不得包含 "query-side" / "read-side"。
   * 触发：命令侧声明允许查询读模型，违反 CQRS 读写分离原则。
   */
  "AP-CMD-QUERY-01": (artifacts) => {
    const findings: string[] = [];
    const arch = artifacts.architectureDocument;
    for (const layer of arch.layering) {
      if (
        layer.name === "command-side" &&
        (layer.allowedDependencies.includes("query-side") || layer.allowedDependencies.includes("read-side"))
      ) {
        findings.push(
          `AP-CMD-QUERY-01 命中：command-side 层 allowedDependencies 包含 query-side/read-side，` +
            `命令侧可能直接查询读模型（违反 CQRS 读写分离原则）。` +
            `层职责：${layer.responsibility}`
        );
      }
    }
    return findings;
  },

  /**
   * AP-AGG-MUT-01: aggregate-mutate-without-event（CQRS-ES 范式，原为 reasoning，但本批次降级为静态可判）
   *
   * 判定：聚合发布的领域事件列表不得为空（CQRS-ES 范式下状态变更必须以事件记录）。
   * 触发：CQRS-ES 范式下存在聚合未声明任何发布事件。
   *
   * 注：原范式定义中此反模式为 reasoning，但本批次 DESIGN Loop 通过聚合的 publishedEvents
   * 字段可静态观察，故纳入静态判定。这是基于设计文档可观察特征的真实判定，非 mock。
   */
  "AP-AGG-MUT-01": (artifacts, paradigm) => {
    if (paradigm.id !== "cqrs-es") return []; // 仅 CQRS-ES 范式适用
    const findings: string[] = [];
    for (const agg of artifacts.domainModelDocument.aggregates) {
      if (agg.publishedEvents.length === 0) {
        findings.push(
          `AP-AGG-MUT-01 命中：CQRS-ES 范式下聚合 ${agg.name} 的 publishedEvents 为空，` +
            `聚合状态变更必须以事件形式记录（事件溯源核心约束）。`
        );
      }
    }
    return findings;
  },

  /**
   * AP-SHARED-DB-01: shared-database-microservice（Microservice 范式）
   *
   * 判定：boundedContexts 中不得有上下文的 responsibility 包含 "共享数据库" / "shared database"。
   * 触发：限界上下文职责描述中提及共享数据库，违反微服务独立数据库原则。
   */
  "AP-SHARED-DB-01": (artifacts) => {
    const findings: string[] = [];
    const arch = artifacts.architectureDocument;
    for (const ctx of arch.boundedContexts) {
      if (ctx.responsibility.includes("共享数据库") || ctx.responsibility.toLowerCase().includes("shared database")) {
        findings.push(
          `AP-SHARED-DB-01 命中：限界上下文 ${ctx.name} 的 responsibility 提及共享数据库，` +
            `微服务必须每服务独立数据库（破坏服务独立性的最严重反模式）。` +
            `职责描述：${ctx.responsibility}`
        );
      }
    }
    return findings;
  },

  /**
   * AP-PROJ-MUT-AGG-01: projector-mutates-aggregate（CQRS-ES 范式，静态可判）
   *
   * 判定：query.application.projections 层的 allowedDependencies 不得包含
   *       "command.domain.aggregates"。
   * 触发：投影器层声明允许依赖命令侧聚合，意味着投影器可能直接修改聚合状态，
   *       违反 CQRS 单向数据流（投影器是只读消费者）与事件溯源不可变性原则。
   *
   * 实现说明：本判定基于设计文档可观察特征（layering.allowedDependencies），
   * 不依赖代码层分析，符合 design 阶段的判定边界。
   */
  "AP-PROJ-MUT-AGG-01": (artifacts) => {
    const findings: string[] = [];
    const arch = artifacts.architectureDocument;
    for (const layer of arch.layering) {
      if (
        layer.name === "query.application.projections" &&
        layer.allowedDependencies.includes("command.domain.aggregates")
      ) {
        findings.push(
          `AP-PROJ-MUT-AGG-01 命中：query.application.projections 层 allowedDependencies 包含 command.domain.aggregates，` +
            `投影器可能修改聚合状态（违反 CQRS 单向数据流，投影器是只读消费者）。` +
            `层职责：${layer.responsibility}`
        );
      }
    }
    return findings;
  },
});

// ============================================================================
// StaticDesignEvaluator 类
// ============================================================================

/**
 * 静态 DESIGN Loop 评估器（implement DesignEvaluatorProtocol）
 *
 * 提供真实判定逻辑（禁止 mock）：
 * - 范式一致性：比对 architectureDocument.dependencyRules 与 paradigm.dependencyRules
 * - 设计完整性：每个 UserStory 的 domainEventCandidates 必须有对应聚合承载
 * - 反模式零命中：遍历 paradigm.antiPatterns，对静态可判规则逐条判定
 * - signalEvidence 证据强制：自主选择时（非锁定）signalEvidence 必须非空
 *
 * 评估模式：
 * - strict（默认）：任一判定项失败即打回
 * - lenient：仅 blocker 级问题打回，major/warning 记录到 findings 不影响 passed
 */
export class StaticDesignEvaluator implements DesignEvaluatorProtocol {
  /**
   * 评估器内部评估模式（不可变，构造时设定）
   */
  private readonly mode: DesignEvaluationMode;

  /**
   * 是否处于范式锁定场景（影响 signalEvidence 证据强制判定）
   *
   * - true：paradigm_lock 锁定场景，跳过 signalEvidence 证据强制判定
   * - false：自主选择场景，signalEvidence 必须非空
   */
  private readonly paradigmLocked: boolean;

  /**
   * @param mode 评估模式（strict / lenient，默认 strict）
   * @param paradigmLocked 是否处于范式锁定场景（默认 false，自主选择场景）
   */
  constructor(mode: DesignEvaluationMode = "strict", paradigmLocked: boolean = false) {
    this.mode = mode;
    this.paradigmLocked = paradigmLocked;
  }

  /**
   * 对设计产出进行独立评估并返回判定
   *
   * 执行流程：
   * 1. 范式一致性判定（dependencyRules 一致性 + layering 覆盖性）
   * 2. 设计完整性判定（每个 UserStory 有聚合承载）
   * 3. 反模式零命中判定（遍历静态可判反模式）
   * 4. signalEvidence 证据强制判定（仅自主选择场景）
   * 5. 汇总 findings，按严重级别决定 passed
   *
   * @param artifacts 设计产出
   * @param paradigm 选中的范式定义
   * @returns 评估判定结果
   */
  async evaluate(artifacts: DesignArtifacts, paradigm: ArchitectureParadigm): Promise<DesignEvaluationVerdict> {
    // 收集所有 findings（每条 { severity, message }）
    const findingsWithSeverity: Array<{ severity: DesignVerdictSeverity; message: string }> = [];

    // ===== 判定项 1：范式一致性 =====
    const paradigmConsistencyFindings = this.checkParadigmConsistency(artifacts, paradigm);
    findingsWithSeverity.push(...paradigmConsistencyFindings);

    // ===== 判定项 2：设计完整性 =====
    const completenessFindings = this.checkDesignCompleteness(artifacts);
    findingsWithSeverity.push(...completenessFindings);

    // ===== 判定项 3：反模式零命中 =====
    const antiPatternFindings = this.checkAntiPatterns(artifacts, paradigm);
    findingsWithSeverity.push(...antiPatternFindings);

    // ===== 判定项 4：signalEvidence 证据强制 =====
    if (!this.paradigmLocked) {
      const evidenceFindings = this.checkSignalEvidence(artifacts);
      findingsWithSeverity.push(...evidenceFindings);
    }

    // ===== 汇总判定 =====
    return this.buildVerdict(findingsWithSeverity);
  }

  // ============================ 私有判定方法 ============================

  /**
   * 判定项 1：范式一致性
   *
   * 判定规则：
   * 1. architectureDocument.selectedParadigmId 必须与 paradigm.id 一致
   * 2. architectureDocument.dependencyRules 必须与 paradigm.dependencyRules 完全一致（按 id 集合比对）
   * 3. architectureDocument.layering 必须覆盖 paradigm.dependencyRules 涉及的全部层
   *    （fromLayer 与 forbiddenToLayers 中出现的层名必须存在于 layering）
   *
   * @param artifacts 设计产出
   * @param paradigm 选中的范式定义
   * @returns 命中问题列表（每条含 severity 与描述）
   */
  private checkParadigmConsistency(
    artifacts: DesignArtifacts,
    paradigm: ArchitectureParadigm
  ): Array<{ severity: DesignVerdictSeverity; message: string }> {
    const findings: Array<{ severity: DesignVerdictSeverity; message: string }> = [];
    const arch = artifacts.architectureDocument;

    // 1. 范式 ID 一致性
    if (arch.selectedParadigmId !== paradigm.id) {
      findings.push({
        severity: "blocker",
        message:
          `范式一致性失败：architectureDocument.selectedParadigmId=${arch.selectedParadigmId} ` +
          `与评估器入参 paradigm.id=${paradigm.id} 不一致。架构师产出的范式 ID 必须与所选范式一致。`,
      });
    }

    // 2. dependencyRules 一致性（按 id 集合比对）
    const archRuleIds = new Set(arch.dependencyRules.map((r) => r.id));
    const paradigmRuleIds = new Set(paradigm.dependencyRules.map((r) => r.id));
    const missingRuleIds = [...paradigmRuleIds].filter((id) => !archRuleIds.has(id));
    const extraRuleIds = [...archRuleIds].filter((id) => !paradigmRuleIds.has(id));
    if (missingRuleIds.length > 0) {
      findings.push({
        severity: "blocker",
        message:
          `范式一致性失败：architectureDocument.dependencyRules 缺失范式定义的规则 ` +
          `[${missingRuleIds.join(", ")}]。架构师必须完整引用范式的 dependencyRules。`,
      });
    }
    if (extraRuleIds.length > 0) {
      findings.push({
        severity: "warning",
        message:
          `范式一致性警告：architectureDocument.dependencyRules 包含范式未定义的规则 ` +
          `[${extraRuleIds.join(", ")}]。建议移除非范式规则或确认是否范式扩展。`,
      });
    }

    // 3. layering 覆盖性（依赖规则涉及的层必须出现在 layering 中）
    const layerNames = new Set(arch.layering.map((l) => l.name));
    const requiredLayers = new Set<string>();
    for (const rule of paradigm.dependencyRules) {
      requiredLayers.add(rule.fromLayer);
      for (const toLayer of rule.forbiddenToLayers) {
        requiredLayers.add(toLayer);
      }
    }
    const missingLayers = [...requiredLayers].filter((l) => !layerNames.has(l));
    if (missingLayers.length > 0) {
      findings.push({
        severity: "major",
        message:
          `范式一致性失败：architectureDocument.layering 缺失范式依赖规则涉及的层 ` +
          `[${missingLayers.join(", ")}]。layering 必须覆盖范式 dependencyRules 中出现的全部层。`,
      });
    }

    return findings;
  }

  /**
   * 判定项 2：设计完整性
   *
   * 判定规则：每个 UserStory 必须有至少一个 Aggregate 承载。
   * 承载关系判定：
   * 1. UserStory.domainEventCandidates 中的事件名必须能在 domainModelDocument.domainEvents 找到对应事件
   * 2. 该事件的 publisher 必须是 domainModelDocument.aggregates 中的某个聚合名
   *
   * 触发条件：
   * - UserStory.domainEventCandidates 为空 → 缺少领域事件候选（warning）
   * - 候选事件在 domainEvents 中找不到 → 事件未在领域模型中定义（major）
   * - 找到事件但 publisher 不在 aggregates 中 → 聚合承载缺失（major）
   * - UserStory 没有任何承载聚合 → 设计完整性失败（major）
   *
   * @param artifacts 设计产出
   * @returns 命中问题列表
   */
  private checkDesignCompleteness(
    artifacts: DesignArtifacts
  ): Array<{ severity: DesignVerdictSeverity; message: string }> {
    const findings: Array<{ severity: DesignVerdictSeverity; message: string }> = [];
    const arch = artifacts.architectureDocument;
    const domainModel = artifacts.domainModelDocument;
    const userStories = artifacts.structuredRequirement.userStories;

    // 构建事件名 → 事件定义映射
    const eventMap = new Map<string, { name: string; publisher: string }>();
    for (const evt of domainModel.domainEvents) {
      eventMap.set(evt.name, { name: evt.name, publisher: evt.publisher });
    }

    // 构建聚合名集合
    const aggregateNames = new Set<string>(domainModel.aggregates.map((a) => a.name));

    // 同时考虑 boundedContexts 中声明的聚合（架构师可能在限界上下文中声明聚合）
    for (const ctx of arch.boundedContexts) {
      for (const agg of ctx.aggregates) {
        aggregateNames.add(agg);
      }
    }

    // 逐个 UserStory 检查承载关系
    for (const story of userStories) {
      // 候选事件为空 → 缺少领域事件候选
      if (story.domainEventCandidates.length === 0) {
        findings.push({
          severity: "warning",
          message:
            `设计完整性警告：UserStory ${story.id}（${story.role} ${story.action}）` +
            `未声明 domainEventCandidates，无法判定聚合承载关系。建议 PM 补充领域事件候选。`,
        });
        continue;
      }

      // 检查每个候选事件是否有聚合承载
      let hasHostAggregate = false;
      for (const candidateEventName of story.domainEventCandidates) {
        const evt = eventMap.get(candidateEventName);
        if (!evt) {
          findings.push({
            severity: "major",
            message:
              `设计完整性失败：UserStory ${story.id} 的候选事件 ${candidateEventName} ` +
              `未在 domainModelDocument.domainEvents 中定义。架构师必须为每个候选事件设计领域事件。`,
          });
          continue;
        }
        if (!aggregateNames.has(evt.publisher)) {
          findings.push({
            severity: "major",
            message:
              `设计完整性失败：UserStory ${story.id} 的候选事件 ${candidateEventName} ` +
              `的 publisher ${evt.publisher} 不在聚合清单中。事件必须由聚合发布。`,
          });
          continue;
        }
        hasHostAggregate = true;
      }

      // 没有承载聚合 → 设计完整性失败
      if (!hasHostAggregate) {
        findings.push({
          severity: "major",
          message:
            `设计完整性失败：UserStory ${story.id}（${story.role} ${story.action}）` +
            `没有任何聚合承载。每个用户故事必须有至少一个聚合承载其领域事件。`,
        });
      }
    }

    return findings;
  }

  /**
   * 判定项 3：反模式零命中
   *
   * 判定规则：遍历 paradigm.antiPatterns，对以下两类反模式逐条判定：
   * 1. detection="static" 的反模式（范式定义即静态可判）
   * 2. detection="reasoning" 但在本评估器 STATIC_ANTI_PATTERN_CHECKERS 表中
   *    注册了判定函数的反模式（基于设计文档可观察特征降级为静态可判）
   *
   * 取上述两类反模式的并集，按 ID 派发到 STATIC_ANTI_PATTERN_CHECKERS 表中
   * 对应的判定函数。未在表中注册的反模式跳过（避免误判）。
   *
   * 严重级别映射：命中反模式的 severity 取反模式定义的 severity（blocker/major/warning）。
   *
   * 实现说明：第 2 类降级场景对应 EAG 方案 §5.2.2 评估器判定的设计意图——
   * 部分范式定义中标记为 reasoning 的反模式（如 CQRS-ES 的 AP-AGG-MUT-01），
   * 通过聚合的 publishedEvents 字段可在设计文档阶段静态观察，故纳入静态判定。
   * 这是基于设计文档可观察特征的真实判定逻辑，非 mock。
   *
   * @param artifacts 设计产出
   * @param paradigm 选中的范式定义
   * @returns 命中问题列表
   */
  private checkAntiPatterns(
    artifacts: DesignArtifacts,
    paradigm: ArchitectureParadigm
  ): Array<{ severity: DesignVerdictSeverity; message: string }> {
    const findings: Array<{ severity: DesignVerdictSeverity; message: string }> = [];

    // 收集范式定义的全部可判反模式：
    // - detection="static" 的反模式（范式定义即静态可判）
    // - 在 STATIC_ANTI_PATTERN_CHECKERS 表中注册了判定函数的反模式
    //   （覆盖 detection="reasoning" 但本评估器降级为静态可判的场景）
    const checkableAntiPatterns: AntiPattern[] = paradigm.antiPatterns.filter(
      (ap) => ap.detection === "static" || STATIC_ANTI_PATTERN_CHECKERS[ap.id] !== undefined
    );

    for (const ap of checkableAntiPatterns) {
      // 派发到对应的判定函数
      const checker = STATIC_ANTI_PATTERN_CHECKERS[ap.id];
      if (!checker) {
        // 未注册判定函数的反模式跳过（避免误判，但记录到 findings 提示）
        findings.push({
          severity: "warning",
          message:
            `反模式 ${ap.id}（${ap.name}）声明为静态可判但本评估器未实现判定逻辑，已跳过。` +
            `建议在 STATIC_ANTI_PATTERN_CHECKERS 表中注册判定函数。`,
        });
        continue;
      }
      // 执行判定
      const hits = checker(artifacts, paradigm);
      // 命中即按反模式 severity 记录
      for (const hit of hits) {
        findings.push({
          severity: ap.severity,
          message: hit,
        });
      }
    }

    return findings;
  }

  /**
   * 判定项 4：signalEvidence 证据强制
   *
   * 判定规则：自主选择范式时（非 paradigm_lock 锁定），signalEvidence 必须非空
   * 且至少包含 1 个信号维度的证据。
   *
   * 触发条件：
   * - signalEvidence 为空对象（无任何键） → 证据缺失（blocker）
   * - signalEvidence 的值为空字符串 → 证据无效（blocker）
   *
   * 对应 EAG 方案 §5.1.1 范式选择防误判机制三要素之一：证据强制。
   *
   * @param artifacts 设计产出
   * @returns 命中问题列表
   */
  private checkSignalEvidence(artifacts: DesignArtifacts): Array<{ severity: DesignVerdictSeverity; message: string }> {
    const findings: Array<{ severity: DesignVerdictSeverity; message: string }> = [];
    const evidence = artifacts.architectureDocument.signalEvidence;
    const evidenceKeys = Object.keys(evidence);

    // 证据为空
    if (evidenceKeys.length === 0) {
      findings.push({
        severity: "blocker",
        message:
          `signalEvidence 证据强制失败：自主选择范式时 signalEvidence 必须非空，` +
          `至少包含 1 个信号维度的证据（引用需求原文）。` +
          `对应 EAG 方案 §5.1.1 范式选择防误判机制三要素之一：证据强制。`,
      });
      return findings;
    }

    // 证据值不能为空字符串
    for (const key of evidenceKeys) {
      const value = evidence[key];
      if (!value || value.trim().length === 0) {
        findings.push({
          severity: "blocker",
          message:
            `signalEvidence 证据强制失败：信号维度 ${key} 的证据为空字符串。` +
            `每个信号维度的证据必须引用需求原文片段。`,
        });
      }
    }

    return findings;
  }

  /**
   * 汇总判定：根据 findings 与评估模式决定 passed / severity
   *
   * 决策规则：
   * - strict 模式：任一 finding（含 warning）即 passed=false
   * - lenient 模式：仅 blocker 级 finding 使 passed=false，major/warning 记录但不影响 passed
   * - severity：取最高级别（无 finding 时为 warning，表示通过但有提示）
   *
   * @param findingsWithSeverity 全部 findings
   * @returns 最终判定结果
   */
  private buildVerdict(
    findingsWithSeverity: Array<{ severity: DesignVerdictSeverity; message: string }>
  ): DesignEvaluationVerdict {
    // 提取 findings 文本列表
    const findings = findingsWithSeverity.map((f) => f.message);

    // 计算最高严重级别
    let maxRank: DesignVerdictSeverity = "warning";
    for (const f of findingsWithSeverity) {
      maxRank = maxSeverity(maxRank, f.severity);
    }

    // 决策 passed
    let passed: boolean;
    if (this.mode === "strict") {
      // strict：任一 finding 即不通过
      passed = findingsWithSeverity.length === 0;
    } else {
      // lenient：仅 blocker 级 finding 不通过
      passed = !findingsWithSeverity.some((f) => f.severity === "blocker");
    }

    // 构建 reason
    let reason: string;
    let suggestedFix: string;
    if (passed) {
      if (findings.length === 0) {
        reason = "DESIGN Loop 评估全部通过：范式一致性 / 设计完整性 / 反模式零命中 / 证据强制 四项判定均通过。";
        suggestedFix = "";
      } else {
        reason = `DESIGN Loop 评估通过（${this.mode} 模式），但存在 ${findings.length} 条提示：` + findings.join("; ");
        suggestedFix = "建议按 findings 提示优化设计文档，但不阻塞进入下一阶段。";
      }
    } else {
      const blockerCount = findingsWithSeverity.filter((f) => f.severity === "blocker").length;
      const majorCount = findingsWithSeverity.filter((f) => f.severity === "major").length;
      const warningCount = findingsWithSeverity.filter((f) => f.severity === "warning").length;
      reason =
        `DESIGN Loop 评估未通过（${this.mode} 模式）：` +
        `blocker=${blockerCount}, major=${majorCount}, warning=${warningCount}。` +
        `具体问题：${findings.join("; ")}`;
      suggestedFix =
        `请架构师根据 findings 修正设计文档后重试：` +
        `1. 范式一致性：检查 dependencyRules 与 layering 是否完整引用范式定义；` +
        `2. 设计完整性：为每个 UserStory 设计承载聚合与对应领域事件；` +
        `3. 反模式零命中：检查 layering.allowedDependencies 与 boundedContexts.responsibility 是否触发静态反模式；` +
        `4. 证据强制：自主选择范式时 signalEvidence 必须引用需求原文片段。`;
    }

    return {
      passed,
      reason,
      severity: maxRank,
      findings,
      suggestedFix,
    };
  }
}
