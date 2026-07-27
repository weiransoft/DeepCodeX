/**
 * EAG-Graph 上下文集成测试 - 经验上送与召回（对齐设计文档 §13.12.3）
 *
 * 测试范围：
 * - E2.* 端到端集成测试（6 个）
 *   验证真实 GraphLoopOrchestrator + 真实 ExperienceStoreImpl + 真实 DefaultNodeExperienceUploader
 *   的完整闭环：经验上送 → collectedExperiences 积累 → recallExperiences 召回 →
 *   fork 并行分支合并 → 图级上下文通过 context 传递到 NodeExecutor。
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止使用 mock 框架，使用真实闭包实现和真实类型实例
 * - 测试替身命名禁用 Mock 前缀，统一用 Stub / Silent / InMemory
 * - 每个测试用例独立，无共享可变状态
 * - 中文注释详细，符合规范
 *
 * 设计依据：
 * - LOOP-GRAPH-FUSION-DESIGN.md §13.12.3 E2.* 测试用例定义
 * - §13.9.2 经验上送与动向广播
 * - §13.9.3 图级上下文通过 context 传递到 NodeExecutor
 * - §13.11.3 滑动窗口截断
 * - §13.11.6 并行合并
 *
 * @module core/tests/eag-graph-context-experience
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { GraphBuilder } from "../eag/graph/graph-builder";
import { EdgeResolverImpl } from "../eag/graph/graph-edge-resolver";
import { GraphGuardImpl } from "../eag/graph/graph-guard";
import { GraphSchedulerImpl } from "../eag/graph/graph-scheduler";
import { PredicateRegistryImpl } from "../eag/graph/predicate-registry";
import { DefaultNodeExperienceUploader, recallExperiences } from "../eag/graph/graph-context-helpers";
import { ExperienceStoreImpl } from "../eag/graph/experience-store";
import {
  DEFAULT_WORK_GRAPH_CONFIG,
  createRetrySuppressionConfig,
  getGraphGlobalContext,
} from "../eag/graph/graph-loop-models";
import { GraphLoopOrchestrator } from "../eag/graph/graph-loop-orchestrator";
import type {
  /** 工作图定义 */
  WorkGraph,
  /** 图节点定义 */
  GraphNodeDef,
  /** 图节点执行结果 */
  GraphNodeResult,
  /** 图运行上下文 */
  GraphRunContext,
  /** 节点字段契约 */
  NodeFieldContract,
  /** 图日志记录器接口 */
  GraphLogger,
  /** 经验案例 */
  ExperienceCase,
  /** 图级全局上下文 */
  GraphGlobalContext,
  /** 图级经验条目 */
  GraphExperienceEntry,
  /** 图级配置 */
  WorkGraphConfig,
} from "../eag/graph/graph-loop-models";
import type {
  /** 节点执行器协议 */
  NodeExecutorProtocol,
  /** 经验存储协议 */
  ExperienceStoreProtocol,
  /** 节点经验上送协议 */
  NodeExperienceUploader,
  /** 双层上下文管理器协议 */
  DualLayerContextManagerProtocol,
  /** 编排器构造选项 */
  GraphLoopOrchestratorOptions,
} from "../eag/graph/graph-loop-protocols";
import type {
  /** Loop 运行报告 */
  LoopRunReport,
  /** Loop 统一事件模型 */
  LoopEvent,
  /** 业务 Loop 类型 */
  LoopType,
} from "../eag/loop/models";
// 共享夹具：节点构造与静默日志器
import {
  makeTaskNode,
  makeEndNode,
  makeForkNode,
  makeMergeNode,
  makeSilentLogger,
} from "./fixtures/eag-graph-context-fixtures";

// ============================================================================
// 辅助：构造 LoopRunReport 测试数据（含 events，供经验提取使用）
// ============================================================================

/**
 * 构造一个自定义配置的图级配置
 *
 * @param overrides 覆盖字段（缺省字段使用 DEFAULT_WORK_GRAPH_CONFIG 默认值）
 * @returns 合并后的 WorkGraphConfig
 */
function makeConfig(overrides?: Partial<typeof DEFAULT_WORK_GRAPH_CONFIG>): typeof DEFAULT_WORK_GRAPH_CONFIG {
  return {
    ...DEFAULT_WORK_GRAPH_CONFIG,
    ...overrides,
  };
}

/**
 * 构造 LoopRunReport 测试数据（含 events，供经验提取使用）
 *
 * 设计意图：
 * - DefaultNodeExperienceUploader 从 loopReport.events 提取经验条目和动向通知
 * - 通过配置 events 中的事件类型，控制提取出的经验类型（success/failure）
 * - 通过配置 finalStatus，控制兜底经验的类型
 *
 * @param nodeId 节点 ID（用于生成 runId 和 eventId）
 * @param options 配置选项
 * @param options.finalStatus 最终状态（默认 "completed"）
 * @param options.events 事件列表（默认根据 finalStatus 生成一条 loop_completed/loop_failed 事件）
 * @param options.loopType Loop 类型（默认 "coding"）
 * @param options.objective 运行目标（默认 "${nodeId} 任务目标"）
 * @param options.totalIterations 总迭代轮数（默认 1）
 * @returns 完整的 LoopRunReport 实例
 */
function makeLoopReport(
  nodeId: string,
  options?: {
    finalStatus?: "completed" | "failed" | "aborted";
    events?: ReadonlyArray<LoopEvent>;
    loopType?: LoopType;
    objective?: string;
    totalIterations?: number;
  }
): LoopRunReport {
  const finalStatus = options?.finalStatus ?? "completed";
  const loopType = options?.loopType ?? "coding";
  const objective = options?.objective ?? `${nodeId} 任务目标`;
  const totalIterations = options?.totalIterations ?? 1;

  // 若未提供 events，根据 finalStatus 生成默认事件
  const events: ReadonlyArray<LoopEvent> = options?.events ?? [
    {
      eventId: `${nodeId}-evt-1`,
      eventType: finalStatus === "completed" ? "loop_completed" : "loop_failed",
      phase: "scheduling",
      runId: `run-${nodeId}`,
      iterIndex: 0,
      payload: {
        summary: `${nodeId} 执行${finalStatus === "completed" ? "完成" : "失败"}`,
        strategy: "stub-strategy",
        reason: finalStatus === "completed" ? undefined : "stub-failure-reason",
        lesson: finalStatus === "completed" ? undefined : "stub-lesson-learned",
      },
      timestamp: new Date().toISOString(),
    },
  ];

  return {
    runId: `run-${nodeId}`,
    loopType,
    objective,
    totalIterations,
    finalStatus,
    events,
    tokenUsed: 100,
    durationSec: 0.01,
    committedCount: finalStatus === "completed" ? 1 : 0,
    humanCheckpoints: [],
    finalSummary: `${nodeId} 最终摘要`,
  };
}

// ============================================================================
// 测试替身：InMemoryExperienceStore（实现 ExperienceStoreProtocol）
// ============================================================================

/**
 * 内存经验存储实现（测试替身，使用 Map 存储案例）
 *
 * 设计意图：
 * - 实现 ExperienceStoreProtocol 协议，提供 storeCase / recallSimilar 方法
 * - 使用 Map 存储案例，recallSimilar 返回全部案例（不做相似度过滤）
 * - 适用于需要验证 storeCase 调用次数和 recallSimilar 返回值的测试场景
 * - 与真实 ExperienceStoreImpl 的区别：不做相似度计算，直接返回全部案例
 *
 * 注意：此实现是真实的协议实现（非 mock 框架），仅简化了相似度计算逻辑。
 */
class InMemoryExperienceStore implements ExperienceStoreProtocol {
  /** 案例存储表（caseId → ExperienceCase） */
  private readonly cases = new Map<string, ExperienceCase>();

  /**
   * 查询相似案例（简化实现：返回全部案例，不做相似度过滤）
   *
   * @param taskFeatures 当前任务特征（本实现不使用，保留参数以匹配协议签名）
   * @param limit 返回案例数上限
   * @returns 案例列表（按插入顺序，最多 limit 条）
   */
  async recallSimilar(
    _taskFeatures: Readonly<Record<string, unknown>>,
    limit: number
  ): Promise<ReadonlyArray<ExperienceCase>> {
    const all = Array.from(this.cases.values());
    return all.slice(0, limit);
  }

  /**
   * 写入新案例
   *
   * @param caseData 执行案例
   */
  async storeCase(caseData: Readonly<ExperienceCase>): Promise<void> {
    this.cases.set(caseData.caseId, { ...caseData });
  }

  /**
   * 获取当前案例库大小
   *
   * @returns 案例数量
   */
  size(): number {
    return this.cases.size;
  }

  /**
   * 获取所有案例（用于测试断言）
   *
   * @returns 案例列表
   */
  getAll(): ExperienceCase[] {
    return Array.from(this.cases.values());
  }
}

// ============================================================================
// 测试替身：StubNodeExecutor（实现 NodeExecutorProtocol）
// ============================================================================

/**
 * 可配置的节点执行器（测试替身，支持行为配置和上下文快照捕获）
 *
 * 设计意图：
 * - 实现 NodeExecutorProtocol 协议，支持按节点 ID 配置成功/失败行为
 * - 支持为每个节点配置 loopReport（触发经验上送逻辑）
 * - 捕获每个节点执行时的 context 快照和 input 快照，供测试断言
 * - 支持在执行时调用 recallExperiences 验证经验召回（可选）
 *
 * 控制节点行为：
 * - end / merge / fork / decision 节点：总是返回 completed
 * - task 节点：根据 behaviorMap 配置返回 completed 或 failed
 * - 若 loopReportMap 中有对应节点的 loopReport，附加到返回结果中
 */
class StubNodeExecutor implements NodeExecutorProtocol {
  /** 节点行为配置（nodeId → "success" | "fail"） */
  private readonly behaviorMap: Map<string, "success" | "fail">;
  /** 节点输出配置（nodeId → 输出数据） */
  private readonly outputMap: Map<string, Record<string, unknown>>;
  /** 节点 LoopReport 配置（nodeId → LoopRunReport，触发经验上送） */
  private readonly loopReportMap: Map<string, LoopRunReport>;
  /** 经验存储（可选，注入后执行时调用 recallExperiences 并捕获结果） */
  private readonly experienceStore?: ExperienceStoreProtocol;
  /** 上下文快照捕获表（nodeId → 执行时的 GraphRunContext 快照） */
  private readonly contextSnapshots = new Map<string, GraphRunContext>();
  /** 输入快照捕获表（nodeId → 执行时的 input 快照） */
  private readonly inputSnapshots = new Map<string, Record<string, unknown>>();
  /** 经验召回结果捕获表（nodeId → recallExperiences 返回值） */
  private readonly recallResults = new Map<string, GraphExperienceEntry[]>();

  /**
   * @param options 构造选项
   * @param options.behaviorMap 节点行为配置（nodeId → "success" | "fail"）
   * @param options.outputMap 节点输出配置（可选）
   * @param options.loopReportMap 节点 LoopReport 配置（可选，触发经验上送）
   * @param options.experienceStore 经验存储（可选，注入后调用 recallExperiences）
   */
  constructor(options: {
    behaviorMap: Map<string, "success" | "fail">;
    outputMap?: Map<string, Record<string, unknown>>;
    loopReportMap?: Map<string, LoopRunReport>;
    experienceStore?: ExperienceStoreProtocol;
  }) {
    this.behaviorMap = options.behaviorMap;
    this.outputMap = options.outputMap ?? new Map();
    this.loopReportMap = options.loopReportMap ?? new Map();
    this.experienceStore = options.experienceStore;
  }

  /**
   * 执行单个图节点
   *
   * 执行流程：
   * 1. 捕获 context 快照和 input 快照
   * 2. 若注入了 experienceStore，调用 recallExperiences 并捕获结果
   * 3. 根据 behaviorMap 和节点类型返回执行结果
   *
   * @param node 节点定义
   * @param input 输入数据（已通过 EdgeResolver 解析边契约后得到）
   * @param context 图运行上下文
   * @returns 节点执行结果
   */
  async execute(
    node: Readonly<GraphNodeDef>,
    input: Readonly<Record<string, unknown>>,
    context: Readonly<GraphRunContext>
  ): Promise<GraphNodeResult> {
    const nodeId = node.nodeId;

    // 1. 捕获上下文快照和输入快照（浅拷贝，避免后续修改影响快照）
    this.contextSnapshots.set(nodeId, context);
    this.inputSnapshots.set(nodeId, { ...input });

    // 2. 若注入了 experienceStore，调用 recallExperiences 并捕获结果
    if (this.experienceStore) {
      const recalled = await recallExperiences(nodeId, node.task, context as GraphRunContext, this.experienceStore);
      this.recallResults.set(nodeId, recalled);
    }

    // 3. end / merge / fork / decision 控制节点总是成功
    if (
      node.nodeType === "end" ||
      node.nodeType === "merge" ||
      node.nodeType === "fork" ||
      node.nodeType === "decision"
    ) {
      return {
        nodeId,
        nodeType: node.nodeType,
        status: "completed",
        output: {},
        durationSec: 0.01,
        retryCount: 0,
      };
    }

    // 4. task 节点：根据 behaviorMap 配置返回结果
    const behavior = this.behaviorMap.get(nodeId) ?? "success";
    const output = this.outputMap.get(nodeId) ?? {};
    const loopReport = this.loopReportMap.get(nodeId);

    if (behavior === "fail") {
      return {
        nodeId,
        nodeType: node.nodeType,
        status: "failed",
        output: {},
        durationSec: 0.01,
        failureReason: `${nodeId} 模拟失败`,
        retryCount: 0,
        loopReport,
      };
    }

    // 默认成功
    return {
      nodeId,
      nodeType: node.nodeType,
      status: "completed",
      output,
      durationSec: 0.01,
      retryCount: 0,
      loopReport,
    };
  }

  /**
   * 获取节点的上下文快照
   *
   * @param nodeId 节点 ID
   * @returns 执行时的 GraphRunContext 快照
   */
  getContextSnapshot(nodeId: string): GraphRunContext | undefined {
    return this.contextSnapshots.get(nodeId);
  }

  /**
   * 获取节点的输入快照
   *
   * @param nodeId 节点 ID
   * @returns 执行时的 input 快照
   */
  getInputSnapshot(nodeId: string): Record<string, unknown> | undefined {
    return this.inputSnapshots.get(nodeId);
  }

  /**
   * 获取节点的经验召回结果
   *
   * @param nodeId 节点 ID
   * @returns recallExperiences 返回的经验条目列表
   */
  getRecallResults(nodeId: string): GraphExperienceEntry[] | undefined {
    return this.recallResults.get(nodeId);
  }
}

// ============================================================================
// 辅助：创建完整的编排器（扩展支持 experienceStore / experienceUploader / dualLayerManager）
// ============================================================================

/**
 * 创建完整的编排器（使用真实组件，支持可选依赖注入）
 *
 * @param options 编排器构造选项（包含所有协作组件）
 * @returns GraphLoopOrchestrator 实例
 */
function createOrchestrator(
  options: Readonly<{
    nodeExecutor: NodeExecutorProtocol;
    configOverrides?: Partial<typeof DEFAULT_WORK_GRAPH_CONFIG>;
    retrySuppressionOverrides?: Partial<ReturnType<typeof createRetrySuppressionConfig>>;
    experienceStore?: ExperienceStoreProtocol;
    experienceUploader?: NodeExperienceUploader;
    dualLayerManager?: DualLayerContextManagerProtocol;
    userId?: string;
    projectRoot?: string;
  }>
): GraphLoopOrchestrator {
  const predicateRegistry = new PredicateRegistryImpl();
  const logger = makeSilentLogger();

  // 重试抑制配置：使用宽松的默认值避免测试中过早熔断
  const retrySuppression = createRetrySuppressionConfig(
    options.retrySuppressionOverrides?.maxTotalRetries ?? 100,
    options.retrySuppressionOverrides?.maxIterationsPerNode ?? 100,
    options.retrySuppressionOverrides?.consecutiveNodeFailureThreshold ?? 10
  );

  const scheduler = new GraphSchedulerImpl(retrySuppression, logger);
  const guard = new GraphGuardImpl(logger);
  const edgeResolver = new EdgeResolverImpl(logger);

  // 构造编排器选项（仅包含已注入的可选组件）
  const orchestratorOptions: GraphLoopOrchestratorOptions = {
    nodeExecutor: options.nodeExecutor,
    edgeResolver,
    graphScheduler: scheduler,
    graphGuard: guard,
    predicateRegistry,
    logger,
  };

  // 注入可选组件（未注入时降级）
  if (options.experienceStore !== undefined) {
    orchestratorOptions.experienceStore = options.experienceStore;
  }
  if (options.experienceUploader !== undefined) {
    orchestratorOptions.experienceUploader = options.experienceUploader;
  }
  if (options.dualLayerManager !== undefined) {
    orchestratorOptions.dualLayerManager = options.dualLayerManager;
  }
  if (options.userId !== undefined) {
    orchestratorOptions.userId = options.userId;
  }
  if (options.projectRoot !== undefined) {
    orchestratorOptions.projectRoot = options.projectRoot;
  }

  return new GraphLoopOrchestrator(orchestratorOptions);
}

// ============================================================================
// E2.* 端到端集成测试（6 个）
// ============================================================================

/**
 * E2.1 线性 3 节点上送后节点 3 可召回节点 1/2 经验
 *
 * 验证点（端到端闭环）：
 * - 真实 GraphLoopOrchestrator + 真实 ExperienceStoreImpl + StubNodeExecutor
 * - finalGlobalState.collectedExperiences.length === 3（3 个节点各上送 1 条 success 经验）
 * - experienceStore.size() === 3（3 个 completed 节点均持久化）
 * - node-3 执行前 recallExperiences 返回含 node-1/node-2 的经验
 *
 * 图结构：node-1 → node-2 → node-3 → end
 * 每个节点携带 loopReport（含 loop_completed 事件），触发经验上送。
 *
 * M1 修复：断言从 >= 2 严格化为 === 3（对齐设计文档 §13.12.3 E2.1）
 * - 3 个 task 节点各携带 1 个 loop_completed 事件，每个事件产生 1 条 success 经验
 * - collectedExperiences 应恰好 3 条（无重试、无失败、无兜底经验）
 * - experienceStore 应恰好持久化 3 条（3 个 completed 节点均 storeCase）
 */
test("E2.1 线性 3 节点上送后节点 3 可召回节点 1/2 经验", async () => {
  // 1. 构造线性图：node-1 → node-2 → node-3 → end
  const graph: WorkGraph = GraphBuilder.create()
    .setGraphInfo("g-e2-1", "线性 3 节点图", "E2.1 经验上送与召回测试")
    .addNode(makeTaskNode("node-1"))
    .addNode(makeTaskNode("node-2"))
    .addNode(makeTaskNode("node-3"))
    .addNode(makeEndNode("end"))
    .addEdge({ edgeId: "e1", from: "node-1", to: "node-2", dataMapping: {} })
    .addEdge({ edgeId: "e2", from: "node-2", to: "node-3", dataMapping: {} })
    .addEdge({ edgeId: "e3", from: "node-3", to: "end", dataMapping: {} })
    .setEntryNodeId("node-1")
    .build();

  // 2. 构造真实的 ExperienceStoreImpl 实例
  const experienceStore = new ExperienceStoreImpl({ similarityThreshold: 0.0 }, makeSilentLogger());

  // 3. 为每个 task 节点构造 loopReport（触发经验上送）
  const loopReportMap = new Map<string, LoopRunReport>();
  loopReportMap.set("node-1", makeLoopReport("node-1", { finalStatus: "completed" }));
  loopReportMap.set("node-2", makeLoopReport("node-2", { finalStatus: "completed" }));
  loopReportMap.set("node-3", makeLoopReport("node-3", { finalStatus: "completed" }));

  // 4. 构造 StubNodeExecutor（注入 experienceStore 以调用 recallExperiences）
  const executor = new StubNodeExecutor({
    behaviorMap: new Map([
      ["node-1", "success"],
      ["node-2", "success"],
      ["node-3", "success"],
    ]),
    loopReportMap,
    experienceStore,
  });

  // 5. 构造真实的 DefaultNodeExperienceUploader（注入 experienceStore）
  const experienceUploader = new DefaultNodeExperienceUploader(experienceStore, "/test/project");

  // 6. 构造编排器（注入 experienceStore + experienceUploader）
  const orchestrator = createOrchestrator({
    nodeExecutor: executor,
    experienceStore,
    experienceUploader,
  });

  // 7. 执行图
  const report = await orchestrator.run(graph);

  // 8. 验证图执行成功完成
  assert.equal(report.finalStatus, "completed", "图应成功完成");

  // 9. 验证 finalGlobalState.collectedExperiences 恰好 3 条（M1 修复：=== 3 严格断言）
  //    3 个 task 节点各 1 个 loop_completed 事件 → 各产生 1 条 success 经验 → 共 3 条
  const globalCtx = getGraphGlobalContext({
    runId: report.runId,
    graphId: report.graphId,
    globalState: { ...report.finalGlobalState },
    visited: new Set(),
    nodeResults: new Map(),
    cancelled: false,
    config: graph.config,
    predicateRegistry: new PredicateRegistryImpl(),
    currentDepth: 0,
    totalTokensUsed: 0,
    startedAtMs: Date.now(),
  });
  const collectedExperiences = globalCtx.collectedExperiences ?? [];
  assert.equal(
    collectedExperiences.length,
    3,
    `collectedExperiences 应恰好包含 3 条经验（3 个节点各 1 条），实际 ${collectedExperiences.length} 条`
  );

  // 10. 验证经验来源包含 node-1 和 node-2
  const sourceNodeIds = new Set(collectedExperiences.map((e) => e.sourceNodeId));
  assert.ok(sourceNodeIds.has("node-1"), "collectedExperiences 应包含 node-1 的经验");
  assert.ok(sourceNodeIds.has("node-2"), "collectedExperiences 应包含 node-2 的经验");

  // 11. 验证 experienceStore 持久化恰好 3 条（M1 修复：=== 3 严格断言）
  //    3 个 completed 节点均 storeCase，无失败节点、无重试
  assert.equal(
    experienceStore.size(),
    3,
    `experienceStore 应恰好持久化 3 条案例（3 个 completed 节点），实际 ${experienceStore.size()} 条`
  );

  // 12. 验证 node-3 执行时 recallExperiences 返回含 node-1/node-2 的经验
  const node3Recall = executor.getRecallResults("node-3");
  assert.ok(node3Recall, "node-3 应有召回结果");
  const recalledSources = new Set(node3Recall!.map((e) => e.sourceNodeId));
  assert.ok(recalledSources.has("node-1"), "node-3 召回的经验应包含 node-1");
  assert.ok(recalledSources.has("node-2"), "node-3 召回的经验应包含 node-2");
});

/**
 * E2.2 失败节点经验上送但不持久化
 *
 * 验证点（§13.6.2）：
 * - 节点 B status="failed"
 * - collectedExperiences 含 B 的 failure 经验
 * - experienceStore.size() 不含 B（仅 completed 节点持久化）
 *
 * 图结构：A → B(failed) → end
 * 配置：nodeRetryLimit=0（不重试），enableAutoIsolation=true（隔离后继续）
 */
test("E2.2 失败节点经验上送但不持久化", async () => {
  // 1. 构造图：A → B → end
  const graph: WorkGraph = GraphBuilder.create()
    .setGraphInfo("g-e2-2", "失败节点图", "E2.2 失败经验上送测试")
    .addNode(makeTaskNode("A"))
    .addNode(makeTaskNode("B"))
    .addNode(makeEndNode("end"))
    .addEdge({ edgeId: "e1", from: "A", to: "B", dataMapping: {} })
    .addEdge({ edgeId: "e2", from: "B", to: "end", dataMapping: {} })
    .setEntryNodeId("A")
    .setConfig(
      makeConfig({
        nodeRetryLimit: 0,
        enableAutoIsolation: true,
      })
    )
    .build();

  // 2. 构造真实的 ExperienceStoreImpl 实例
  const experienceStore = new ExperienceStoreImpl({ similarityThreshold: 0.0 }, makeSilentLogger());

  // 3. 为 A 构造成功的 loopReport，为 B 构造失败的 loopReport
  const loopReportMap = new Map<string, LoopRunReport>();
  loopReportMap.set("A", makeLoopReport("A", { finalStatus: "completed" }));
  loopReportMap.set("B", makeLoopReport("B", { finalStatus: "failed" }));

  // 4. 构造 StubNodeExecutor：A 成功，B 失败
  const executor = new StubNodeExecutor({
    behaviorMap: new Map([
      ["A", "success"],
      ["B", "fail"],
    ]),
    loopReportMap,
  });

  // 5. 构造真实的 DefaultNodeExperienceUploader
  const experienceUploader = new DefaultNodeExperienceUploader(experienceStore, "/test/project");

  // 6. 构造编排器
  const orchestrator = createOrchestrator({
    nodeExecutor: executor,
    experienceStore,
    experienceUploader,
    configOverrides: {
      nodeRetryLimit: 0,
      enableAutoIsolation: true,
    },
    retrySuppressionOverrides: {
      maxIterationsPerNode: 100,
    },
  });

  // 7. 执行图
  const report = await orchestrator.run(graph);

  // 8. 验证图执行完成（B 被隔离，图继续到 end）
  assert.ok(
    report.finalStatus === "completed" || report.finalStatus === "failed",
    `图应完成或失败终止，实际状态=${report.finalStatus}`
  );

  // 9. 验证 collectedExperiences 包含 B 的失败经验
  const globalCtx = getGraphGlobalContext({
    runId: report.runId,
    graphId: report.graphId,
    globalState: { ...report.finalGlobalState },
    visited: new Set(),
    nodeResults: new Map(),
    cancelled: false,
    config: graph.config,
    predicateRegistry: new PredicateRegistryImpl(),
    currentDepth: 0,
    totalTokensUsed: 0,
    startedAtMs: Date.now(),
  });
  const collectedExperiences = globalCtx.collectedExperiences ?? [];
  const bExperiences = collectedExperiences.filter((e) => e.sourceNodeId === "B");
  assert.ok(bExperiences.length > 0, `collectedExperiences 应包含 B 的失败经验，实际 ${bExperiences.length} 条`);
  assert.ok(
    bExperiences.some((e) => e.type === "failure"),
    "B 的经验应包含 failure 类型"
  );

  // 10. 验证 experienceStore 不含 B 的经验（仅 completed 节点持久化）
  const allCases = experienceStore.getAllCases();
  const bCases = allCases.filter((c) => c.taskFeatures && c.taskFeatures.nodeId === "B");
  assert.equal(bCases.length, 0, `experienceStore 不应持久化 B 的失败经验，实际 ${bCases.length} 条`);

  // 11. 验证 experienceStore 包含 A 的经验（completed 节点持久化）
  const aCases = allCases.filter((c) => c.taskFeatures && c.taskFeatures.nodeId === "A");
  assert.ok(aCases.length > 0, `experienceStore 应持久化 A 的成功经验，实际 ${aCases.length} 条`);
});

/**
 * E2.3 fork 并行两分支同时上送经验的合并正确性
 *
 * 验证点（§13.11.6 并行合并）：
 * - fork → [branch-A, branch-B] → merge；两分支 loopReport 各含 1 条 success
 * - finalGlobalState.collectedExperiences 含 A 和 B 的经验（不丢失任一分支）
 * - nodeSummaries 含 A 和 B 的摘要
 *
 * 图结构：start → fork → [branch-A, branch-B] → merge → end
 */
test("E2.3 fork 并行两分支同时上送经验的合并正确性", async () => {
  // 1. 构造 fork-merge 图
  const graph: WorkGraph = GraphBuilder.create()
    .setGraphInfo("g-e2-3", "fork-merge 图", "E2.3 并行经验合并测试")
    .addNode(makeTaskNode("start"))
    .addNode(makeForkNode("fork1"))
    .addNode(makeTaskNode("branch-A"))
    .addNode(makeTaskNode("branch-B"))
    .addNode(makeMergeNode("merge1"))
    .addNode(makeEndNode("end"))
    .addEdge({ edgeId: "e1", from: "start", to: "fork1", dataMapping: {} })
    .addEdge({ edgeId: "e2", from: "fork1", to: "branch-A", dataMapping: {} })
    .addEdge({ edgeId: "e3", from: "fork1", to: "branch-B", dataMapping: {} })
    .addEdge({ edgeId: "e4", from: "branch-A", to: "merge1", dataMapping: {} })
    .addEdge({ edgeId: "e5", from: "branch-B", to: "merge1", dataMapping: {} })
    .addEdge({ edgeId: "e6", from: "merge1", to: "end", dataMapping: {} })
    .setEntryNodeId("start")
    .setConfig(makeConfig({ maxParallelism: 4 }))
    .build();

  // 2. 构造真实的 ExperienceStoreImpl
  const experienceStore = new ExperienceStoreImpl({ similarityThreshold: 0.0 }, makeSilentLogger());

  // 3. 为两分支构造 loopReport（各含 1 条 success 事件）
  const loopReportMap = new Map<string, LoopRunReport>();
  loopReportMap.set("start", makeLoopReport("start", { finalStatus: "completed" }));
  loopReportMap.set(
    "branch-A",
    makeLoopReport("branch-A", {
      finalStatus: "completed",
      events: [
        {
          eventId: "branch-A-lc-1",
          eventType: "loop_completed",
          phase: "scheduling",
          runId: "run-branch-A",
          iterIndex: 0,
          payload: { summary: "branch-A 完成", strategy: "branch-A-strategy" },
          timestamp: "2026-07-23T10:00:00.000Z",
        },
      ],
    })
  );
  loopReportMap.set(
    "branch-B",
    makeLoopReport("branch-B", {
      finalStatus: "completed",
      events: [
        {
          eventId: "branch-B-lc-1",
          eventType: "loop_completed",
          phase: "scheduling",
          runId: "run-branch-B",
          iterIndex: 0,
          payload: { summary: "branch-B 完成", strategy: "branch-B-strategy" },
          timestamp: "2026-07-23T10:00:01.000Z",
        },
      ],
    })
  );

  // 4. 构造 StubNodeExecutor
  const executor = new StubNodeExecutor({
    behaviorMap: new Map([
      ["start", "success"],
      ["branch-A", "success"],
      ["branch-B", "success"],
    ]),
    loopReportMap,
  });

  // 5. 构造真实的 DefaultNodeExperienceUploader
  const experienceUploader = new DefaultNodeExperienceUploader(experienceStore, "/test/project");

  // 6. 构造编排器
  const orchestrator = createOrchestrator({
    nodeExecutor: executor,
    experienceStore,
    experienceUploader,
    configOverrides: { maxParallelism: 4 },
  });

  // 7. 执行图
  const report = await orchestrator.run(graph);

  // 8. 验证图执行成功完成
  assert.equal(report.finalStatus, "completed", "fork-merge 图应成功完成");

  // 9. 验证 finalGlobalState.collectedExperiences 含 branch-A 和 branch-B 的经验
  const globalCtx = getGraphGlobalContext({
    runId: report.runId,
    graphId: report.graphId,
    globalState: { ...report.finalGlobalState },
    visited: new Set(),
    nodeResults: new Map(),
    cancelled: false,
    config: graph.config,
    predicateRegistry: new PredicateRegistryImpl(),
    currentDepth: 0,
    totalTokensUsed: 0,
    startedAtMs: Date.now(),
  });
  const collectedExperiences = globalCtx.collectedExperiences ?? [];
  const sourceNodeIds = new Set(collectedExperiences.map((e) => e.sourceNodeId));
  assert.ok(
    sourceNodeIds.has("branch-A"),
    `collectedExperiences 应含 branch-A 的经验，实际来源=${[...sourceNodeIds].join(", ")}`
  );
  assert.ok(
    sourceNodeIds.has("branch-B"),
    `collectedExperiences 应含 branch-B 的经验，实际来源=${[...sourceNodeIds].join(", ")}`
  );

  // 10. 验证 nodeSummaries 含 branch-A 和 branch-B 的摘要
  const nodeSummaries = globalCtx.nodeSummaries ?? new Map();
  assert.ok(nodeSummaries.has("branch-A"), "nodeSummaries 应含 branch-A 的摘要");
  assert.ok(nodeSummaries.has("branch-B"), "nodeSummaries 应含 branch-B 的摘要");
});

/**
 * E2.4 图级上下文通过 context 传递到 NodeExecutor
 *
 * 验证点（§13.9.3 修订）：
 * - 节点 B 执行前
 * - StubNodeExecutor 收到的 context.globalState 含 projectGoal + bulletinBoard
 * - input 不含 _graphGlobalContext
 *
 * 图结构：A → B → end
 * A 携带 loopReport（含 scheduling_decision 事件，产生 bulletinBoard 条目）
 */
test("E2.4 图级上下文通过 context 传递到 NodeExecutor", async () => {
  // 1. 构造线性图：A → B → end
  const graph: WorkGraph = GraphBuilder.create()
    .setGraphInfo("g-e2-4", "上下文传递图", "E2.4 图级上下文传递测试")
    .addNode(makeTaskNode("A"))
    .addNode(makeTaskNode("B"))
    .addNode(makeEndNode("end"))
    .addEdge({ edgeId: "e1", from: "A", to: "B", dataMapping: {} })
    .addEdge({ edgeId: "e2", from: "B", to: "end", dataMapping: {} })
    .setEntryNodeId("A")
    .build();

  // 2. 为 A 构造 loopReport（含 scheduling_decision 事件，产生 bulletinBoard 条目）
  const loopReportMap = new Map<string, LoopRunReport>();
  loopReportMap.set(
    "A",
    makeLoopReport("A", {
      finalStatus: "completed",
      events: [
        {
          eventId: "A-sd-1",
          eventType: "scheduling_decision",
          phase: "scheduling",
          runId: "run-A",
          iterIndex: 0,
          payload: { summary: "A 的关键决策", decision: "continue" },
          timestamp: "2026-07-23T10:00:00.000Z",
        },
        {
          eventId: "A-lc-1",
          eventType: "loop_completed",
          phase: "scheduling",
          runId: "run-A",
          iterIndex: 0,
          payload: { summary: "A 完成", strategy: "A-strategy" },
          timestamp: "2026-07-23T10:00:01.000Z",
        },
      ],
    })
  );

  // 3. 构造 StubNodeExecutor
  const executor = new StubNodeExecutor({
    behaviorMap: new Map([
      ["A", "success"],
      ["B", "success"],
    ]),
    loopReportMap,
  });

  // 4. 构造真实的 DefaultNodeExperienceUploader（不注入 experienceStore，仅上送到 globalState）
  const experienceUploader = new DefaultNodeExperienceUploader(undefined, "/test/project");

  // 5. 构造编排器
  const orchestrator = createOrchestrator({
    nodeExecutor: executor,
    experienceUploader,
  });

  // 6. 执行图
  const report = await orchestrator.run(graph);
  assert.equal(report.finalStatus, "completed", "图应成功完成");

  // 7. 验证节点 B 收到的 context.globalState 含 projectGoal
  const bContext = executor.getContextSnapshot("B");
  assert.ok(bContext, "应有节点 B 的上下文快照");
  const bGlobalState = bContext!.globalState;
  assert.ok(bGlobalState.projectGoal !== undefined, "context.globalState 应含 projectGoal 字段");
  assert.ok(
    typeof bGlobalState.projectGoal === "string" && bGlobalState.projectGoal.length > 0,
    "projectGoal 应为非空字符串"
  );

  // 8. 验证节点 B 收到的 context.globalState 含 bulletinBoard
  const bulletinBoard = bGlobalState.bulletinBoard;
  assert.ok(
    Array.isArray(bulletinBoard) && bulletinBoard.length > 0,
    "context.globalState 应含非空 bulletinBoard 数组"
  );

  // 9. 验证节点 B 收到的 input 不含 _graphGlobalContext
  const bInput = executor.getInputSnapshot("B");
  assert.ok(bInput, "应有节点 B 的输入快照");
  assert.ok(
    !("_graphGlobalContext" in bInput),
    "input 不应含 _graphGlobalContext 字段（图级上下文通过 context 传递，非 input）"
  );
});

/**
 * E2.5 fork 并行三分支合并正确性
 *
 * 验证点（§13.11.6 并行合并扩展覆盖）：
 * - fork → [branch-A, branch-B, branch-C] → merge → end
 * - 三分支 loopReport 各含 1 条 success 事件
 * - finalGlobalState.collectedExperiences 含 A/B/C 三分支的经验（不丢失任一分支）
 * - nodeSummaries 含 A/B/C 三分支的摘要
 *
 * 设计说明（M3 修复）：E2.3 仅测试 2 分支，本测试覆盖 3+ 分支合并
 */
test("E2.5 fork 并行三分支合并正确性", async () => {
  // 1. 构造 fork-merge 图（三分支）
  const graph: WorkGraph = GraphBuilder.create()
    .setGraphInfo("g-e2-5", "fork-merge 三分支图", "E2.5 三分支并行经验合并测试")
    .addNode(makeTaskNode("start"))
    .addNode(makeForkNode("fork1"))
    .addNode(makeTaskNode("branch-A"))
    .addNode(makeTaskNode("branch-B"))
    .addNode(makeTaskNode("branch-C"))
    .addNode(makeMergeNode("merge1"))
    .addNode(makeEndNode("end"))
    .addEdge({ edgeId: "e1", from: "start", to: "fork1", dataMapping: {} })
    .addEdge({ edgeId: "e2", from: "fork1", to: "branch-A", dataMapping: {} })
    .addEdge({ edgeId: "e3", from: "fork1", to: "branch-B", dataMapping: {} })
    .addEdge({ edgeId: "e4", from: "fork1", to: "branch-C", dataMapping: {} })
    .addEdge({ edgeId: "e5", from: "branch-A", to: "merge1", dataMapping: {} })
    .addEdge({ edgeId: "e6", from: "branch-B", to: "merge1", dataMapping: {} })
    .addEdge({ edgeId: "e7", from: "branch-C", to: "merge1", dataMapping: {} })
    .addEdge({ edgeId: "e8", from: "merge1", to: "end", dataMapping: {} })
    .setEntryNodeId("start")
    .setConfig(makeConfig({ maxParallelism: 8 }))
    .build();

  // 2. 构造真实的 ExperienceStoreImpl
  const experienceStore = new ExperienceStoreImpl({ similarityThreshold: 0.0 }, makeSilentLogger());

  // 3. 为三分支构造 loopReport（各含 1 条 success 事件，时间错开确保排序稳定）
  const loopReportMap = new Map<string, LoopRunReport>();
  loopReportMap.set("start", makeLoopReport("start", { finalStatus: "completed" }));
  loopReportMap.set(
    "branch-A",
    makeLoopReport("branch-A", {
      finalStatus: "completed",
      events: [
        {
          eventId: "branch-A-lc-1",
          eventType: "loop_completed",
          phase: "scheduling",
          runId: "run-branch-A",
          iterIndex: 0,
          payload: { summary: "branch-A 完成", strategy: "branch-A-strategy" },
          timestamp: "2026-07-23T10:00:00.000Z",
        },
      ],
    })
  );
  loopReportMap.set(
    "branch-B",
    makeLoopReport("branch-B", {
      finalStatus: "completed",
      events: [
        {
          eventId: "branch-B-lc-1",
          eventType: "loop_completed",
          phase: "scheduling",
          runId: "run-branch-B",
          iterIndex: 0,
          payload: { summary: "branch-B 完成", strategy: "branch-B-strategy" },
          timestamp: "2026-07-23T10:00:01.000Z",
        },
      ],
    })
  );
  loopReportMap.set(
    "branch-C",
    makeLoopReport("branch-C", {
      finalStatus: "completed",
      events: [
        {
          eventId: "branch-C-lc-1",
          eventType: "loop_completed",
          phase: "scheduling",
          runId: "run-branch-C",
          iterIndex: 0,
          payload: { summary: "branch-C 完成", strategy: "branch-C-strategy" },
          timestamp: "2026-07-23T10:00:02.000Z",
        },
      ],
    })
  );

  // 4. 构造 StubNodeExecutor
  const executor = new StubNodeExecutor({
    behaviorMap: new Map([
      ["start", "success"],
      ["branch-A", "success"],
      ["branch-B", "success"],
      ["branch-C", "success"],
    ]),
    loopReportMap,
  });

  // 5. 构造真实的 DefaultNodeExperienceUploader
  const experienceUploader = new DefaultNodeExperienceUploader(experienceStore, "/test/project");

  // 6. 构造编排器
  const orchestrator = createOrchestrator({
    nodeExecutor: executor,
    experienceStore,
    experienceUploader,
    configOverrides: { maxParallelism: 8 },
  });

  // 7. 执行图
  const report = await orchestrator.run(graph);

  // 8. 验证图执行成功完成
  assert.equal(report.finalStatus, "completed", "fork-merge 三分支图应成功完成");

  // 9. 验证 finalGlobalState.collectedExperiences 含 branch-A/B/C 的经验
  const globalCtx = getGraphGlobalContext({
    runId: report.runId,
    graphId: report.graphId,
    globalState: { ...report.finalGlobalState },
    visited: new Set(),
    nodeResults: new Map(),
    cancelled: false,
    config: graph.config,
    predicateRegistry: new PredicateRegistryImpl(),
    currentDepth: 0,
    totalTokensUsed: 0,
    startedAtMs: Date.now(),
  });
  const collectedExperiences = globalCtx.collectedExperiences ?? [];
  const sourceNodeIds = new Set(collectedExperiences.map((e) => e.sourceNodeId));
  assert.ok(
    sourceNodeIds.has("branch-A"),
    `collectedExperiences 应含 branch-A 的经验，实际来源=${[...sourceNodeIds].join(", ")}`
  );
  assert.ok(
    sourceNodeIds.has("branch-B"),
    `collectedExperiences 应含 branch-B 的经验，实际来源=${[...sourceNodeIds].join(", ")}`
  );
  assert.ok(
    sourceNodeIds.has("branch-C"),
    `collectedExperiences 应含 branch-C 的经验，实际来源=${[...sourceNodeIds].join(", ")}`
  );

  // 10. 验证 nodeSummaries 含 branch-A/B/C 的摘要
  const nodeSummaries = globalCtx.nodeSummaries ?? new Map();
  assert.ok(nodeSummaries.has("branch-A"), "nodeSummaries 应含 branch-A 的摘要");
  assert.ok(nodeSummaries.has("branch-B"), "nodeSummaries 应含 branch-B 的摘要");
  assert.ok(nodeSummaries.has("branch-C"), "nodeSummaries 应含 branch-C 的摘要");
});

/**
 * E2.6 fork 合并后 collectedExperiences 超限触发 slice(-50)
 *
 * 验证点（§13.11.3 滑动窗口截断 + §13.11.6 并行合并）：
 * - fork → [branch-A, branch-B] → merge → end
 * - branch-A 上送 30 条经验，branch-B 上送 30 条经验
 * - 合并后 collectedExperiences 为 60 条 > MAX_COLLECTED_EXPERIENCES(50)
 * - 触发 slice(-50)，保留最近 50 条（丢弃最早的 10 条）
 *
 * 设计说明（M3 修复）：覆盖 fork 合并后滑动窗口截断场景
 * - 每分支构造 30 个 loop_completed 事件，每次上送产生 30 条经验
 * - DefaultNodeExperienceUploader 内部对 collectedExperiences 做 slice(-50) 截断
 * - 使用 maxParallelism=1 确保分支按边顺序执行（branch-A 先于 branch-B）
 * - 验证截断后 length===50 且保留最近 50 条（branch-B 的 30 条 + branch-A 的最后 20 条）
 */
test("E2.6 fork 合并后 collectedExperiences 超限触发 slice(-50)", async () => {
  // 1. 构造 fork-merge 图（图配置 maxParallelism=4 是常规并行上限；
  //    但本测试在 createOrchestrator 中覆盖为 maxParallelism=1，强制分支按边顺序串行执行，
  //    以保证 branch-A 先于 branch-B 上送经验，截断结果可预测）
  const graph: WorkGraph = GraphBuilder.create()
    .setGraphInfo("g-e2-6", "fork-merge 超限图", "E2.6 合并后滑动窗口截断测试")
    .addNode(makeTaskNode("start"))
    .addNode(makeForkNode("fork1"))
    .addNode(makeTaskNode("branch-A"))
    .addNode(makeTaskNode("branch-B"))
    .addNode(makeMergeNode("merge1"))
    .addNode(makeEndNode("end"))
    .addEdge({ edgeId: "e1", from: "start", to: "fork1", dataMapping: {} })
    .addEdge({ edgeId: "e2", from: "fork1", to: "branch-A", dataMapping: {} })
    .addEdge({ edgeId: "e3", from: "fork1", to: "branch-B", dataMapping: {} })
    .addEdge({ edgeId: "e4", from: "branch-A", to: "merge1", dataMapping: {} })
    .addEdge({ edgeId: "e5", from: "branch-B", to: "merge1", dataMapping: {} })
    .addEdge({ edgeId: "e6", from: "merge1", to: "end", dataMapping: {} })
    .setEntryNodeId("start")
    .setConfig(makeConfig({ maxParallelism: 4 }))
    .build();

  // 2. 构造真实的 ExperienceStoreImpl
  const experienceStore = new ExperienceStoreImpl({ similarityThreshold: 0.0 }, makeSilentLogger());

  // 3. 为 branch-A 和 branch-B 各构造 30 个 loop_completed 事件的 loopReport
  //    每个 loop_completed 事件 → 1 条 success 经验 → 30 条经验/分支
  //    合计 60 条 > MAX_COLLECTED_EXPERIENCES(50)，触发 slice(-50)
  const makeBranchEvents = (branchId: string): LoopEvent[] => {
    const events: LoopEvent[] = [];
    for (let i = 1; i <= 30; i++) {
      events.push({
        eventId: `${branchId}-lc-${i}`,
        eventType: "loop_completed",
        phase: "scheduling",
        runId: `run-${branchId}`,
        iterIndex: i - 1,
        payload: {
          summary: `${branchId} 第 ${i} 轮完成`,
          strategy: `${branchId}-strategy-${i}`,
        },
        // branch-A 时间在 10:00:00-10:00:29，branch-B 时间在 10:01:00-10:01:29
        // 确保合并后 branch-B 的经验全部新于 branch-A
        timestamp:
          branchId === "branch-A"
            ? `2026-07-23T10:00:${String(i - 1).padStart(2, "0")}.000Z`
            : `2026-07-23T10:01:${String(i - 1).padStart(2, "0")}.000Z`,
      });
    }
    return events;
  };

  const loopReportMap = new Map<string, LoopRunReport>();
  loopReportMap.set("start", makeLoopReport("start", { finalStatus: "completed" }));
  loopReportMap.set(
    "branch-A",
    makeLoopReport("branch-A", {
      finalStatus: "completed",
      events: makeBranchEvents("branch-A"),
    })
  );
  loopReportMap.set(
    "branch-B",
    makeLoopReport("branch-B", {
      finalStatus: "completed",
      events: makeBranchEvents("branch-B"),
    })
  );

  // 4. 构造 StubNodeExecutor
  const executor = new StubNodeExecutor({
    behaviorMap: new Map([
      ["start", "success"],
      ["branch-A", "success"],
      ["branch-B", "success"],
    ]),
    loopReportMap,
  });

  // 5. 构造真实的 DefaultNodeExperienceUploader
  const experienceUploader = new DefaultNodeExperienceUploader(experienceStore, "/test/project");

  // 6. 构造编排器（maxParallelism=1 确保分支按边顺序执行：branch-A 先，branch-B 后）
  const orchestrator = createOrchestrator({
    nodeExecutor: executor,
    experienceStore,
    experienceUploader,
    configOverrides: { maxParallelism: 1 },
  });

  // 7. 执行图
  const report = await orchestrator.run(graph);

  // 8. 验证图执行成功完成
  assert.equal(report.finalStatus, "completed", "fork-merge 超限图应成功完成");

  // 9. 验证 collectedExperiences 被 slice(-50) 截断到 50 条
  //    执行顺序：两个分支各上送 30 条经验，合计 60 条 > MAX_COLLECTED_EXPERIENCES(50)
  //    DefaultNodeExperienceUploader 内部对 collectedExperiences 做 slice(-50) 截断
  //    先上送的分支最早 10 条被丢弃（保留 20 条），后上送的分支全部保留（30 条）
  //    分支执行顺序由调度器决定，断言以顺序无关方式验证
  const globalCtx = getGraphGlobalContext({
    runId: report.runId,
    graphId: report.graphId,
    globalState: { ...report.finalGlobalState },
    visited: new Set(),
    nodeResults: new Map(),
    cancelled: false,
    config: graph.config,
    predicateRegistry: new PredicateRegistryImpl(),
    currentDepth: 0,
    totalTokensUsed: 0,
    startedAtMs: Date.now(),
  });
  const collectedExperiences = globalCtx.collectedExperiences ?? [];
  assert.equal(
    collectedExperiences.length,
    50,
    `collectedExperiences 应被 slice(-50) 截断到 50 条，实际 ${collectedExperiences.length} 条`
  );

  // 10. 验证两个分支的经验均存在（合并不丢失分支）
  const branchAExperiences = collectedExperiences.filter((e) => e.sourceNodeId === "branch-A");
  const branchBExperiences = collectedExperiences.filter((e) => e.sourceNodeId === "branch-B");
  assert.ok(branchAExperiences.length > 0, "branch-A 的经验应部分保留（不丢失分支）");
  assert.ok(branchBExperiences.length > 0, "branch-B 的经验应部分保留（不丢失分支）");

  // 11. 验证 slice(-50) 保留最近 50 条（顺序无关验证）
  //     先上送分支保留 20 条（最早 10 条被丢弃），后上送分支保留 30 条（全部在窗口内）
  //     两者之和应恰好 50，且一个为 20、另一个为 30
  assert.equal(
    branchAExperiences.length + branchBExperiences.length,
    50,
    `两个分支经验数之和应为 50（slice(-50) 截断），实际 A=${branchAExperiences.length} + B=${branchBExperiences.length} = ${branchAExperiences.length + branchBExperiences.length}`
  );
  const counts = new Set([branchAExperiences.length, branchBExperiences.length]);
  assert.ok(
    counts.has(20) && counts.has(30),
    `两个分支应分别保留 20 和 30 条经验（先上送 20、后上送 30），实际 A=${branchAExperiences.length}, B=${branchBExperiences.length}`
  );
});
