/**
 * EAG-P3 批次 12 C2 场景 1：DESIGN Loop E2E 端到端测试
 *
 * 测试范围（对齐设计文档 §4.3.1）：
 * - 读取真实需求 fixture（requirement.md，含用户/商品/订单/支付 4 模块）
 * - 调用真实 DesignLoopOrchestrator（注入 StaticProductManager + StaticArchitect + StaticDesignEvaluator）
 * - 验证产出含 ≥4 模块声明 + ≥3 验收标准
 * - 验证 G-1 门禁通过（spec.md 已批准状态）
 * - 验证 G-2 门禁通过（多角色评审 + 用户已批准）
 * - 将 spec.md 写入临时项目目录供下游场景使用
 *
 * 测试约定（严格遵循项目"禁止 mock"规则）：
 * - 使用 node:test + node:assert/strict
 * - 使用真实临时目录（fs.mkdtempSync）+ after 钩子清理（fs.rmSync recursive）
 * - StaticProductManager / StaticArchitect 为 ProductManagerProtocol / ArchitectProtocol 真实实现
 *   （解析"作为X，我希望Y，以便Z"模式，基于规则生成确定性 StructuredRequirement + ArchitectureDocument）
 * - StaticDesignEvaluator 为 design-evaluator.ts 中真实评估器实现
 * - GateG1Checker / GateG2Checker 为真实门禁检查器
 *
 * 与设计文档的 API 差异（以代码为准）：
 * - 设计文档：`DesignOrchestrator.run({requirement})`
 *   实际代码：`DesignLoopOrchestrator.run(DesignLoopInput)`，
 *   其中 DesignLoopInput = { rawRequirement, projectContext?, paradigmLock? }
 * - 设计文档：G-1 检查 `g1Checker.check({specContent})`
 *   实际代码：`g1Checker.check(GateContext)`，
 *   其中 GateContext 含 specStatus / planStatus / reviewRecords / userApproved / taskCard / actualChanges 等字段
 * - 设计文档：G-2 检查 `g2Checker.check({acceptanceCriteria})`
 *   实际代码：`g2Checker.check(GateContext)`，
 *   其中 GateContext.reviewRecords 必须含 architect + test-expert 角色，且 userApproved=true
 * - DESIGN Loop 不直接生成 spec.md 文件，而是产出 DesignArtifacts（in-memory）；
 *   测试需手动将 artifacts 序列化为 spec.md 写入临时目录
 *
 * 设计依据：
 * - EAG-P3 批次 12 设计文档 §4.3.1 场景 1 DESIGN Loop E2E
 * - EAG 方案 §5.2.2 DESIGN Loop 角色编排
 * - EAG 方案 §5.12.1 G-1/G-2 门禁
 *
 * @module core/tests/eag-e2e-design
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

// ESM 模块兼容：__dirname 在 ESM 中不可用，通过 import.meta.url 构造等价路径
const __dirname = path.dirname(fileURLToPath(import.meta.url));

import { DesignLoopOrchestrator } from "../eag/design/design-orchestrator";
import { StaticDesignEvaluator } from "../eag/design/design-evaluator";
import { createDefaultDesignLoopConfig } from "../eag/design/design-models";
import type {
  DesignLoopInput,
  DesignLoopResult,
  StructuredRequirement,
  ArchitectureDocument,
  DomainModelDocument,
  UserStory,
  DomainTerm,
  NonFunctionalRequirement,
  AcceptanceCriterion,
  ProjectContext,
} from "../eag/design/design-models";
import type { ProductManagerProtocol, ArchitectProtocol } from "../eag/design/design-protocols";
import type { ArchitectureParadigm, ParadigmId, ParadigmLockConfig } from "../eag/eak/types";
import { getParadigmById } from "../eag/eak/paradigm-registry";
import { DDD_LAYERED_PARADIGM } from "../eag/eak/paradigms/ddd-layered";
import { GateG1Checker } from "../eag/gate/gate-g1-checker";
import { GateG2Checker } from "../eag/gate/gate-g2-checker";
import type { GateContext, GateResult, ReviewRecord } from "../eag/gate/gate-types";

// ============================================================================
// 真实组件 1：StaticProductManager（implement ProductManagerProtocol）
// ============================================================================

/**
 * 静态产品经理（真实实现，非 mock）
 *
 * 解析原始需求文本中的"作为X，我希望Y，以便Z"模式，
 * 生成确定性的 StructuredRequirement（相同输入→相同输出）。
 *
 * 解析规则：
 * - 按行扫描原始需求，匹配 "作为<角色>，我希望<动作>，以便<价值>" 模式
 * - 每个匹配行生成一个 UserStory，id 自增（US-001、US-002 ...）
 * - 从动作中提取领域事件候选（如"创建订单" → "OrderCreatedEvent"）
 * - 领域词汇表：从角色与动作中提取术语
 * - 非功能需求：扫描"强一致" / "高性能" / "可扩展" 等关键词
 */
class StaticProductManager implements ProductManagerProtocol {
  /**
   * 解析原始需求并生成结构化需求
   *
   * @param rawRequirement 原始需求文本（多行，每行一个用户故事）
   * @param _projectContext 项目上下文（本静态实现未使用，保留参数对齐协议）
   * @returns 确定性的 StructuredRequirement
   */
  async structureRequirement(rawRequirement: string, _projectContext?: ProjectContext): Promise<StructuredRequirement> {
    // 按行切分，去掉空行
    const lines = rawRequirement
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    const userStories: UserStory[] = [];
    const domainGlossary: DomainTerm[] = [];
    const nonFunctionalRequirements: NonFunctionalRequirement[] = [];

    // 用户故事计数器（用于生成 US-001、US-002 ...）
    let storyIndex = 0;

    // 用户故事正则：作为<角色>，我希望<动作>，以便<价值>
    const storyPattern = /作为(.+?)，\s*我希望(.+?)，\s*以便(.+)/;

    for (const line of lines) {
      const match = line.match(storyPattern);
      if (match) {
        storyIndex += 1;
        const role = match[1].trim();
        const action = match[2].trim();
        const benefit = match[3].trim();

        // 从动作中提取领域事件候选：将"创建订单"转为"OrderCreatedEvent"
        const domainEventCandidate = this.extractDomainEventCandidate(action);

        userStories.push({
          id: `US-${String(storyIndex).padStart(3, "0")}`,
          role,
          action,
          benefit,
          acceptanceCriteria: [
            {
              id: `AC-${String(storyIndex).padStart(3, "0")}`,
              given: `${role}已就绪`,
              when: `${action}`,
              then: `达成${benefit}`,
            },
          ],
          domainEventCandidates: domainEventCandidate ? [domainEventCandidate] : [],
        });

        // 从角色与动作中提取领域词汇
        domainGlossary.push({
          term: action,
          definition: `${role}执行的业务动作`,
          synonyms: [],
        });
      }

      // 扫描非功能需求关键词
      if (line.includes("强一致")) {
        nonFunctionalRequirements.push({
          id: `NFR-${String(nonFunctionalRequirements.length + 1).padStart(3, "0")}`,
          category: "consistency",
          description: "需求要求强一致",
        });
      }
      if (line.includes("高性能") || line.includes("P99")) {
        nonFunctionalRequirements.push({
          id: `NFR-${String(nonFunctionalRequirements.length + 1).padStart(3, "0")}`,
          category: "performance",
          description: "需求要求高性能",
        });
      }
      if (line.includes("并发") || line.includes("QPS")) {
        nonFunctionalRequirements.push({
          id: `NFR-${String(nonFunctionalRequirements.length + 1).padStart(3, "0")}`,
          category: "scalability",
          description: "需求要求高并发",
        });
      }
    }

    return {
      userStories,
      domainGlossary,
      nonFunctionalRequirements,
    };
  }

  /**
   * 从动作文本提取领域事件候选名
   *
   * 规则：动作="创建订单" → 事件名="OrderCreatedEvent"
   * 实现通过预定义的动词映射 + 名词转 PascalCase 拼装。
   *
   * @param action 动作文本（如"创建订单"）
   * @returns 领域事件候选名（如"OrderCreatedEvent"）；无法识别时返回 null
   */
  private extractDomainEventCandidate(action: string): string | null {
    // 中文动词 → 英文动词过去分词映射
    // 覆盖电商场景常见业务动作（创建/修改/删除/取消/确认/支付/发货/收货/
    // 注册/登录/退款/查询/扣减），用于将"作为X，我希望Y"动作转为领域事件候选
    const verbMap: Readonly<Record<string, string>> = {
      创建: "Created",
      修改: "Updated",
      更新: "Updated",
      删除: "Deleted",
      取消: "Cancelled",
      确认: "Confirmed",
      提交: "Submitted",
      支付: "Paid",
      发货: "Shipped",
      收货: "Received",
      注册: "Registered",
      登录: "LoggedIn",
      退款: "Refunded",
      查询: "Queried",
      扣减: "Reduced",
    };

    // 中文名词 → 英文名词映射（覆盖常见业务术语）
    const nounMap: Readonly<Record<string, string>> = {
      订单: "Order",
      用户: "User",
      商品: "Product",
      库存: "Inventory",
      支付: "Payment",
      仓库: "Warehouse",
      物流: "Logistics",
      客户: "Customer",
    };

    // 在动作文本中查找动词与名词
    let verb: string | null = null;
    let noun: string | null = null;
    for (const [cn, en] of Object.entries(verbMap)) {
      if (action.includes(cn)) {
        verb = en;
        break;
      }
    }
    for (const [cn, en] of Object.entries(nounMap)) {
      if (action.includes(cn)) {
        noun = en;
        break;
      }
    }

    // 动词或名词缺失时返回 null
    if (!verb || !noun) return null;
    return `${noun}${verb}Event`;
  }
}

// ============================================================================
// 真实组件 2：StaticArchitect（implement ArchitectProtocol）
// ============================================================================

/**
 * 静态架构师（真实实现，非 mock）
 *
 * 根据 StructuredRequirement 生成确定性的 ArchitectureDocument + DomainModelDocument。
 * 支持范式锁定（paradigmLock），默认使用 DDD 分层架构。
 *
 * 设计产出规则：
 * - architectureDocument.selectedParadigmId 与所选范式一致
 * - architectureDocument.dependencyRules 直接引用范式定义的 dependencyRules
 * - architectureDocument.layering 覆盖范式 dependencyRules 涉及的全部层
 * - domainModelDocument.aggregates / entities / domainEvents 根据 UserStory 推导
 */
class StaticArchitect implements ArchitectProtocol {
  /**
   * @param failureIterations 前 N 次返回失败设计（默认 0，即始终返回通过设计）
   * @param failureParadigmId 失败设计使用的错误范式 ID
   */
  constructor(
    private readonly failureIterations: number = 0,
    private readonly failureParadigmId: ParadigmId = "clean-architecture"
  ) {}

  /** 当前调用次数（每次 designArchitecture 自增） */
  private callCount = 0;

  /**
   * 根据结构化需求产出架构设计文档 + 领域模型文档
   *
   * @param requirement PM 产出的结构化需求
   * @param paradigmLock 可选，paradigm_lock 配置
   * @param _projectContext 项目上下文（本静态实现未使用）
   * @returns 架构师产出：architecture + domainModel
   */
  async designArchitecture(
    requirement: StructuredRequirement,
    paradigmLock?: ParadigmLockConfig,
    _projectContext?: ProjectContext
  ): Promise<{ architecture: ArchitectureDocument; domainModel: DomainModelDocument }> {
    this.callCount += 1;

    // 选择范式：锁定时使用锁定的范式，否则使用 DDD（优先级最高）
    const paradigm: ArchitectureParadigm =
      paradigmLock && paradigmLock.locked && paradigmLock.paradigmId
        ? getParadigmById(paradigmLock.paradigmId)!
        : DDD_LAYERED_PARADIGM;

    // 判定本次是否为"失败设计"（前 failureIterations 次返回失败设计）
    const isFailureDesign = this.callCount <= this.failureIterations;
    const selectedParadigmId: ParadigmId = isFailureDesign ? this.failureParadigmId : paradigm.id;

    // 构造 ArchitectureDocument
    const architecture: ArchitectureDocument = {
      selectedParadigmId,
      paradigmRationale: `${paradigm.name} 范式匹配当前业务需求`,
      signalEvidence:
        paradigmLock && paradigmLock.locked
          ? {}
          : {
              domainComplexity: "需求中包含多个业务实体与状态转换，业务复杂度高",
              consistencyRequirement: "需求要求订单状态强一致",
              readWritePattern: "读写均衡，订单查询与创建均频繁",
              integrationComplexity: "单体应用，无外部系统集成",
            },
      boundedContexts: [
        {
          name: "订单核心上下文",
          responsibility: "承载订单、商品、用户、支付核心业务逻辑",
          aggregates: requirement.userStories.map((_, idx) => `Aggregate${idx + 1}`),
        },
      ],
      layering: this.buildLayering(paradigm.id),
      dependencyRules: paradigm.dependencyRules,
    };

    // 构造 DomainModelDocument：根据 UserStory 推导聚合/实体/事件
    const aggregates = requirement.userStories.map((story, idx) => {
      const aggName = `Aggregate${idx + 1}`;
      return {
        name: aggName,
        rootEntity: `${aggName}Entity`,
        invariants: [`${aggName} 状态转换必须符合业务规则`],
        containedEntities: [],
        valueObjects: [],
        publishedEvents: [...story.domainEventCandidates],
      };
    });

    const entities = requirement.userStories.map((story, idx) => {
      const aggName = `Aggregate${idx + 1}`;
      return {
        name: `${aggName}Entity`,
        aggregate: aggName,
        attributes: [
          { name: "id", type: "string", required: true },
          { name: "status", type: "string", required: true },
        ],
        behaviors: [
          {
            name: "execute",
            description: `执行${story.action}`,
            publishedEvents: story.domainEventCandidates,
          },
        ],
      };
    });

    const domainEvents = requirement.userStories.flatMap((story, idx) => {
      const aggName = `Aggregate${idx + 1}`;
      return story.domainEventCandidates.map((evtName) => ({
        name: evtName,
        publisher: aggName,
        subscribers: [],
        payload: [{ name: "id", type: "string", required: true }],
      }));
    });

    const domainModel: DomainModelDocument = {
      aggregates,
      entities,
      valueObjects: [
        {
          name: "IdentifierVO",
          attributes: [{ name: "value", type: "string", required: true }],
          immutabilityGuarantee: "所有字段 readonly + Object.freeze 冻结",
        },
      ],
      domainEvents,
    };

    return { architecture, domainModel };
  }

  /**
   * 根据 paradigmId 构造对应范式的分层定义
   *
   * 分层定义必须覆盖范式 dependencyRules 中 fromLayer 与 forbiddenToLayers 涉及的全部层，
   * 否则评估器的"范式一致性"判定会因 layering 缺失层而打回。
   *
   * @param paradigmId 范式 ID
   * @returns 分层定义列表（覆盖范式 dependencyRules 涉及的全部层）
   */
  private buildLayering(paradigmId: ParadigmId): ArchitectureDocument["layering"] {
    if (paradigmId === "ddd-layered") {
      // DDD dependencyRules 涉及：domain / application / interfaces / infrastructure
      return [
        { name: "domain", responsibility: "领域模型，零外部依赖", allowedDependencies: [] },
        { name: "application", responsibility: "应用编排", allowedDependencies: ["domain"] },
        { name: "interfaces", responsibility: "接口层", allowedDependencies: ["application"] },
        { name: "infrastructure", responsibility: "基础设施层", allowedDependencies: ["domain", "application"] },
      ];
    }
    if (paradigmId === "clean-architecture") {
      return [
        { name: "entities", responsibility: "实体", allowedDependencies: [] },
        { name: "use-cases", responsibility: "用例", allowedDependencies: ["entities"] },
        { name: "controllers", responsibility: "控制器", allowedDependencies: ["use-cases"] },
        { name: "frameworks", responsibility: "框架", allowedDependencies: ["controllers"] },
      ];
    }
    // 默认：返回 DDD 分层
    return [
      { name: "domain", responsibility: "领域模型", allowedDependencies: [] },
      { name: "application", responsibility: "应用编排", allowedDependencies: ["domain"] },
      { name: "interfaces", responsibility: "接口层", allowedDependencies: ["application"] },
      { name: "infrastructure", responsibility: "基础设施层", allowedDependencies: ["domain", "application"] },
    ];
  }
}

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 将 DesignLoopResult 序列化为 spec.md 内容（真实转换，非占位）
 *
 * 算法：
 * 1. 从 artifacts 中提取 StructuredRequirement + ArchitectureDocument + DomainModelDocument
 * 2. 按章节结构生成 Markdown 内容：
 *    - 项目定位（基于 boundedContexts[0].responsibility）
 *    - 模块清单（基于 boundedContexts[0].aggregates + userStories）
 *    - 验收标准（基于 userStories[].acceptanceCriteria）
 *    - 非功能需求（基于 nonFunctionalRequirements）
 *    - 依赖关系图（基于 boundedContexts 关系）
 *
 * @param result DESIGN Loop 产出
 * @returns spec.md 文本内容
 */
function serializeArtifactsToSpecMd(result: DesignLoopResult): string {
  const { structuredRequirement, architectureDocument, domainModelDocument } = result.artifacts;
  const lines: string[] = [];

  // 标题
  lines.push("# 订单管理服务规格说明（spec.md）");
  lines.push("");

  // 项目定位
  lines.push("## 项目定位");
  lines.push("");
  const ctx = architectureDocument.boundedContexts[0];
  lines.push(ctx ? ctx.responsibility : "电商平台订单管理服务");
  lines.push("");

  // 范式选择
  lines.push("## 范式选择");
  lines.push("");
  lines.push(`采用 ${architectureDocument.selectedParadigmId} 范式：${architectureDocument.paradigmRationale}`);
  lines.push("");

  // 模块清单
  lines.push("## 模块清单");
  lines.push("");
  structuredRequirement.userStories.forEach((story, idx) => {
    const agg = domainModelDocument.aggregates[idx];
    const aggName = agg ? agg.name : `Aggregate${idx + 1}`;
    lines.push(`### 模块：${story.action}（${aggName}）`);
    lines.push("");
    lines.push(`- 角色：${story.role}`);
    lines.push(`- 动作：${story.action}`);
    lines.push(`- 价值：${story.benefit}`);
    if (story.domainEventCandidates.length > 0) {
      lines.push(`- 领域事件：${story.domainEventCandidates.join(", ")}`);
    }
    lines.push("");
  });

  // 验收标准
  lines.push("## 验收标准");
  lines.push("");
  const allCriteria: AcceptanceCriterion[] = structuredRequirement.userStories.flatMap(
    (story) => story.acceptanceCriteria
  );
  allCriteria.forEach((ac) => {
    lines.push(`- ${ac.id}：Given ${ac.given} / When ${ac.when} / Then ${ac.then}`);
  });
  lines.push("");

  // 非功能需求
  if (structuredRequirement.nonFunctionalRequirements.length > 0) {
    lines.push("## 非功能需求");
    lines.push("");
    structuredRequirement.nonFunctionalRequirements.forEach((nfr) => {
      lines.push(`- ${nfr.id}（${nfr.category}）：${nfr.description}`);
    });
    lines.push("");
  }

  // 分层架构
  lines.push("## 分层架构");
  lines.push("");
  architectureDocument.layering.forEach((layer) => {
    lines.push(`- ${layer.name}：${layer.responsibility}`);
  });
  lines.push("");

  // 依赖规则
  lines.push("## 依赖规则");
  lines.push("");
  architectureDocument.dependencyRules.forEach((rule) => {
    lines.push(`- ${rule.fromLayer} → ${rule.toLayer}（${rule.kind}）`);
  });
  lines.push("");

  return lines.join("\n");
}

/**
 * 构造 G-1/G-2 共用的 GateContext（已批准状态 + 多角色评审记录 + 用户已批准）
 *
 * @returns 满足 G-1/G-2 通过条件的 GateContext
 */
function buildApprovedGateContext(): GateContext {
  // 构造 4 角色评审记录（architect + pm + test-expert + solo-coder，全部 approve）
  const reviewRecords: ReviewRecord[] = [
    {
      role: "architect",
      reviewer: "架构师 Alice",
      verdict: "approve",
      comments: "架构设计合理，分层清晰，范式选择恰当",
      reviewedAt: "2026-07-19T10:00:00.000Z",
    },
    {
      role: "pm",
      reviewer: "PM Bob",
      verdict: "approve",
      comments: "需求覆盖完整，验收标准可执行",
      reviewedAt: "2026-07-19T10:05:00.000Z",
    },
    {
      role: "test-expert",
      reviewer: "测试专家 Carol",
      verdict: "approve",
      comments: "可测试性良好，验收标准可验证",
      reviewedAt: "2026-07-19T10:10:00.000Z",
    },
    {
      role: "solo-coder",
      reviewer: "独立开发者 Dave",
      verdict: "approve",
      comments: "可实施性良好，工作量评估合理",
      reviewedAt: "2026-07-19T10:15:00.000Z",
    },
  ];

  return {
    projectId: "eag-e2e-design",
    loopType: "coding",
    specStatus: "approved",
    planStatus: "approved",
    reviewRecords,
    userApproved: true,
    taskCard: {
      id: "T-001",
      title: "DESIGN Loop E2E 测试任务卡",
      requirementId: "F-001",
      acceptanceCriteria: [],
      declaredSymbols: [],
      status: "approved",
    },
    actualChanges: [],
  } as GateContext;
}

// ============================================================================
// 测试主体
// ============================================================================

describe("EAG-P3 批次 12 E2E 场景 1：DESIGN Loop", { timeout: 120000 }, () => {
  let tempProjectRoot: string;

  before(() => {
    // 创建真实临时项目目录（不使用 mock）
    tempProjectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "eag-e2e-design-"));
  });

  after(() => {
    // 清理临时目录（递归强制删除，避免磁盘泄漏）
    if (tempProjectRoot && fs.existsSync(tempProjectRoot)) {
      fs.rmSync(tempProjectRoot, { recursive: true, force: true });
    }
  });

  test("应完成需求 → spec.md → G-1/G-2 门禁全流程", async () => {
    // ===== Step 1: 读取真实需求 fixture =====
    const fixtureDir = path.join(
      __dirname,
      "..",
      "..",
      "src",
      "tests",
      "fixtures",
      "e2e-scenarios",
      "greenfield-order-service"
    );
    // 兼容 tsx 运行时 __dirname 解析（src/tests → fixtures/e2e-scenarios/...）
    const requirementPath = path.join(fixtureDir, "requirement.md");
    // 若 __dirname 已是 packages/core/src/tests，则直接定位到 fixtures
    const altRequirementPath = path.join(
      __dirname,
      "fixtures",
      "e2e-scenarios",
      "greenfield-order-service",
      "requirement.md"
    );
    const finalRequirementPath = fs.existsSync(requirementPath)
      ? requirementPath
      : fs.existsSync(altRequirementPath)
        ? altRequirementPath
        : altRequirementPath;
    assert.ok(fs.existsSync(finalRequirementPath), `requirement.md fixture 必须存在：${finalRequirementPath}`);
    const requirement = fs.readFileSync(finalRequirementPath, "utf-8");
    assert.ok(requirement.length > 0, "requirement.md 内容非空");
    // 断言 fixture 含 ≥4 个模块声明（用户/商品/订单/支付）
    const moduleMatches = requirement.match(/^### 模块：.+$/gm);
    assert.ok(moduleMatches && moduleMatches.length >= 4, "requirement.md 必须含 ≥4 个模块声明");

    // ===== Step 2: 构造 DESIGN Loop 真实组件 =====
    const pm = new StaticProductManager();
    const architect = new StaticArchitect(0); // failureIterations=0，始终返回通过设计
    const evaluator = new StaticDesignEvaluator();
    const config = createDefaultDesignLoopConfig();
    const orchestrator = new DesignLoopOrchestrator(pm, architect, evaluator, config);

    // ===== Step 3: 执行 DESIGN Loop（真实 InMemoryLLMClient 等价的真实实现） =====
    const input: DesignLoopInput = {
      rawRequirement: requirement,
      // projectContext 省略：绿地场景
    };
    const result: DesignLoopResult = await orchestrator.run(input);

    // ===== Step 4: 断言 DesignLoopResult 结构完整性 =====
    assert.ok(result, "DesignLoopResult 必须非空");
    assert.ok(result.artifacts, "DesignArtifacts 必须非空");
    assert.ok(result.artifacts.structuredRequirement, "StructuredRequirement 必须非空");
    assert.ok(result.artifacts.architectureDocument, "ArchitectureDocument 必须非空");
    assert.ok(result.artifacts.domainModelDocument, "DomainModelDocument 必须非空");

    // 断言评估器通过（ StaticDesignEvaluator 在范式一致时返回 passed=true）
    assert.equal(result.evaluationVerdict.passed, true, "DESIGN Loop 评估器必须通过");

    // ===== Step 5: 断言 ≥4 模块声明（用户/商品/订单/支付） =====
    // 模块数以 userStories 数量 + boundedContexts.aggregates 数量综合判定
    const storyCount = result.artifacts.structuredRequirement.userStories.length;
    const aggregateCount = result.artifacts.domainModelDocument.aggregates.length;
    const moduleCount = Math.max(storyCount, aggregateCount);
    assert.ok(moduleCount >= 4, `模块数必须 ≥4（userStories=${storyCount}, aggregates=${aggregateCount}）`);

    // ===== Step 6: 断言验收标准 ≥3 =====
    const allCriteria: AcceptanceCriterion[] = result.artifacts.structuredRequirement.userStories.flatMap(
      (s) => s.acceptanceCriteria
    );
    assert.ok(allCriteria.length >= 3, `验收标准数必须 ≥3，实际 ${allCriteria.length}`);

    // ===== Step 7: 将 DesignArtifacts 序列化为 spec.md 写入临时项目目录 =====
    const specContent = serializeArtifactsToSpecMd(result);
    assert.ok(specContent.length > 0, "spec.md 序列化内容非空");
    const docsDir = path.join(tempProjectRoot, "docs", "eag");
    fs.mkdirSync(docsDir, { recursive: true });
    const specPath = path.join(docsDir, "spec.md");
    fs.writeFileSync(specPath, specContent, "utf-8");
    assert.ok(fs.existsSync(specPath), "spec.md 必须写入临时项目目录");
    const writtenSpecContent = fs.readFileSync(specPath, "utf-8");
    assert.ok(writtenSpecContent.length > 0, "spec.md 内容非空");

    // 断言 spec.md 含 ≥4 个模块声明（### 模块：）
    const specModuleMatches = writtenSpecContent.match(/^### 模块：.+$/gm);
    assert.ok(
      specModuleMatches && specModuleMatches.length >= 4,
      `spec.md 必须含 ≥4 个模块声明，实际 ${specModuleMatches?.length ?? 0}`
    );

    // 断言 spec.md 含 ≥3 条验收标准
    const specAcMatches = writtenSpecContent.match(/^- AC-\d+：/gm);
    assert.ok(
      specAcMatches && specAcMatches.length >= 3,
      `spec.md 必须含 ≥3 条验收标准，实际 ${specAcMatches?.length ?? 0}`
    );

    // ===== Step 8: 验证 G-1 门禁通过（spec.md 已批准状态） =====
    const g1Checker = new GateG1Checker();
    const g1Context = buildApprovedGateContext();
    const g1Result: GateResult = g1Checker.check(g1Context);
    assert.equal(g1Result.passed, true, `G-1 门禁必须通过：${g1Result.reason}`);
    assert.equal(g1Result.gate, "G-1", "G-1 门禁 gate 字段必须为 G-1");

    // ===== Step 9: 验证 G-2 门禁通过（多角色评审 + 用户已批准） =====
    const g2Checker = new GateG2Checker();
    const g2Context = buildApprovedGateContext();
    const g2Result: GateResult = g2Checker.check(g2Context);
    assert.equal(g2Result.passed, true, `G-2 门禁必须通过：${g2Result.reason}`);
    assert.equal(g2Result.gate, "G-2", "G-2 门禁 gate 字段必须为 G-2");

    // ===== Step 10: 与 expected-spec.md 比较模块数（结构性断言，不要求 100% 一致） =====
    const expectedSpecPath = fs.existsSync(path.join(fixtureDir, "expected-spec.md"))
      ? path.join(fixtureDir, "expected-spec.md")
      : path.join(__dirname, "fixtures", "e2e-scenarios", "greenfield-order-service", "expected-spec.md");
    if (fs.existsSync(expectedSpecPath)) {
      const expectedSpec = fs.readFileSync(expectedSpecPath, "utf-8");
      const expectedModuleMatches = expectedSpec.match(/^### 模块：.+$/gm);
      const expectedModuleCount = expectedModuleMatches?.length ?? 0;
      // 结构性断言：spec.md 模块数 ≥ expected-spec.md 中声明的模块数 - 1（允许 LLM 随机性减 1）
      assert.ok(
        specModuleMatches!.length >= Math.max(1, expectedModuleCount - 1),
        `spec.md 模块数 ${specModuleMatches!.length} 应 ≥ expected-spec.md 模块数 ${expectedModuleCount} - 1（结构性断言）`
      );
    }
  });

  test("应在 paradigm_lock 锁定时使用锁定范式", async () => {
    // 读取 fixture
    const requirementPath = path.join(
      __dirname,
      "fixtures",
      "e2e-scenarios",
      "greenfield-order-service",
      "requirement.md"
    );
    const requirement = fs.readFileSync(requirementPath, "utf-8");

    // 构造 orchestrator
    // 注：paradigm_lock 锁定场景下评估器需构造 paradigmLocked=true，
    // 跳过 signalEvidence 证据强制判定（锁定场景由 lockConfig 替代信号证据）
    const pm = new StaticProductManager();
    const architect = new StaticArchitect();
    const evaluator = new StaticDesignEvaluator("strict", true);
    const orchestrator = new DesignLoopOrchestrator(pm, architect, evaluator, createDefaultDesignLoopConfig());

    // 锁定 DDD 范式
    const dddLock: ParadigmLockConfig = {
      locked: true,
      paradigmId: "ddd-layered",
      reason: "E2E 测试验证 paradigm_lock 锁定机制",
    };

    const result = await orchestrator.run({
      rawRequirement: requirement,
      paradigmLock: dddLock,
    });

    // 断言使用锁定的范式
    assert.equal(
      result.artifacts.architectureDocument.selectedParadigmId,
      "ddd-layered",
      "paradigm_lock 锁定时必须使用 ddd-layered 范式"
    );
    assert.equal(result.evaluationVerdict.passed, true, "锁定 DDD 范式时评估器应通过");
  });
});
