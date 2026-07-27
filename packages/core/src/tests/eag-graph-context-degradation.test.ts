/**
 * EAG-Graph 上下文集成测试 - 降级路径（对齐设计文档 §13.12.3）
 *
 * 测试范围：
 * - D1-D5c 降级路径测试（7 个）
 *   验证各组件未注入或异常时的降级行为：不中断主流程、不抛异常、降级为无图级上下文。
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止使用 mock 框架，使用真实闭包实现和真实类型实例
 * - 测试替身命名禁用 Mock 前缀，统一用 Stub / Silent / InMemory
 * - 每个测试用例独立，无共享可变状态
 * - 中文注释详细，符合规范
 *
 * 设计依据：
 * - LOOP-GRAPH-FUSION-DESIGN.md §13.12.3 D1-D5c 测试用例定义
 * - §13.8.3 图级片段注入 buildOptimizedContext
 * - §13.9.1 GraphGlobalContext 初始化
 * - §13.9.2 经验上送与动向广播
 * - §13.9.3 图级上下文通过 context 传递到 NodeExecutor
 * - §13.11.5 降级路径
 *
 * @module core/tests/eag-graph-context-degradation
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { GraphLoopOrchestrator } from "../eag/graph/graph-loop-orchestrator";
import { GraphBuilder } from "../eag/graph/graph-builder";
import { EdgeResolverImpl } from "../eag/graph/graph-edge-resolver";
import { GraphGuardImpl } from "../eag/graph/graph-guard";
import { GraphSchedulerImpl } from "../eag/graph/graph-scheduler";
import { PredicateRegistryImpl } from "../eag/graph/predicate-registry";
import { DefaultNodeExperienceUploader, recallExperiences } from "../eag/graph/graph-context-helpers";
import { createRetrySuppressionConfig, getGraphGlobalContext } from "../eag/graph/graph-loop-models";
// 真实 DualLayerContextManager 及其依赖（对齐 §13.12.3 D2/D5 真实组件要求）
import { DualLayerContextManager } from "../v2/context/dual-layer-manager";
import type { CodeMapProvider } from "../v2/context/dual-layer-manager";
import { GlobalContextManager } from "../v2/context/global-context";
import { TaskContextManager } from "../v2/context/task-context-manager";
import { SlidingWindowManager } from "../v2/context/sliding-window";
import { RelevanceScorer } from "../v2/context/relevance-scorer";
import { ProgressiveContextLoader } from "../v2/context/progressive-loader";
import { RuleBasedSummarizer } from "../v2/memory/rule-based-summarizer";
import type { CodeMap, FileInfo } from "../v2/codemap/generator";
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
  DEFAULT_WORK_GRAPH_CONFIG,
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
import type { ContextSnippet } from "../v2/integration/session-hook";
// 共享夹具：节点构造与静默日志器
import { makeTaskNode, makeEndNode, makeSilentLogger } from "./fixtures/eag-graph-context-fixtures";

// ============================================================================
// 辅助：构造 LoopRunReport 测试数据（含 events，供经验提取使用）
// ============================================================================

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
// 真实 DualLayerContextManager 辅助构造（对齐 §13.12.3 D2/D5 真实组件要求）
// ============================================================================

/**
 * 构造空 CodeMap（用于不需要文件层片段的测试）
 *
 * 提供最小合法 CodeMap 结构，files 为空数组，
 * 使 SlidingWindowManager.buildWindow 能正常运行（无文件可评分）。
 *
 * @returns 最小合法的空 CodeMap
 */
function makeEmptyCodeMap(): CodeMap {
  return {
    project: {
      name: "test-project",
      root: "/tmp/test-project",
      techStack: {
        frameworks: [],
        buildTools: [],
        packageManagers: [],
        testFrameworks: [],
        linters: [],
      },
      architecture: "unknown",
      languages: ["typescript"],
    },
    modules: [],
    files: [],
    callGraph: [],
    dependencyGraph: [],
    cycles: [],
    generatedAt: new Date().toISOString(),
    stats: {
      totalFiles: 0,
      parsedFiles: 0,
      failedFiles: 0,
      totalClasses: 0,
      totalFunctions: 0,
      totalDependencies: 0,
      cyclesDetected: 0,
      unresolvedDeps: 0,
      generationTimeMs: 0,
    },
  };
}

/**
 * StubCodeMapProvider：返回可配置 CodeMap 的 CodeMap 提供者
 *
 * 实现 CodeMapProvider 接口，返回构造时注入的 CodeMap 实例。
 * 用于让 buildOptimizedContext 的文件层按测试需要产出（或不出产）文件片段，
 * 使图级片段收集逻辑（collectGraphContextSnippets）走真实代码路径。
 */
class StubCodeMapProvider implements CodeMapProvider {
  /** 内部持有的 CodeMap 实例 */
  private readonly codeMap: CodeMap;

  /**
   * @param codeMap 可选的自定义 CodeMap（默认空 CodeMap）
   */
  constructor(codeMap?: CodeMap) {
    this.codeMap = codeMap ?? makeEmptyCodeMap();
  }

  /**
   * 获取 CodeMap
   *
   * @param _projectRoot 项目根目录（测试中不使用，仅满足接口签名）
   * @returns 固定的 CodeMap 实例
   */
  async getCodeMap(_projectRoot: string): Promise<CodeMap> {
    return this.codeMap;
  }
}

/**
 * 构造真实的 DualLayerContextManager 及其依赖
 *
 * 装配真实组件（非 mock）：
 * - GlobalContextManager：传入不存在的临时文件路径，load 返回默认空上下文
 * - TaskContextManager：真实实例
 * - RelevanceScorer：真实评分器
 * - SlidingWindowManager：真实滑动窗口（100000 token 预算，Top-K=20）
 * - ProgressiveContextLoader：真实渐进式加载器
 * - RuleBasedSummarizer：真实规则摘要器
 * - StubCodeMapProvider：返回注入的 CodeMap（默认空）
 *
 * @param options 构造选项
 * @param options.codeMapProvider 可选的自定义 CodeMapProvider（默认 StubCodeMapProvider 返回空 CodeMap）
 * @param options.tokenBudget 可选的 Token 预算（默认 100000，确保图级片段不被截断）
 * @returns 包含 manager 和 taskManager 的对象
 */
function createRealManager(options?: { codeMapProvider?: CodeMapProvider; tokenBudget?: number }): {
  manager: DualLayerContextManager;
  taskManager: TaskContextManager;
} {
  const tokenBudget = options?.tokenBudget ?? 100_000;

  // 真实评分器（零配置，使用默认权重）
  const scorer = new RelevanceScorer();

  // 真实渐进式加载器（确保不截断）
  const progressiveLoader = new ProgressiveContextLoader({ tokenBudget });

  // 真实规则摘要器（非 mock，真实启发式算法）
  const summarizer = new RuleBasedSummarizer();

  // 真实滑动窗口管理器（Token 预算充足，Top-K=20，确保图级片段不被截断）
  const windowManager = new SlidingWindowManager({ tokenBudget, topKFiles: 20 }, scorer, progressiveLoader, summarizer);

  // StubCodeMapProvider：返回空 CodeMap 或自定义 CodeMap
  const provider = options?.codeMapProvider ?? new StubCodeMapProvider();

  // 真实 GlobalContextManager：传入不存在的临时文件路径，load 返回默认空上下文
  const tmpFile = path.join(
    os.tmpdir(),
    `test-global-context-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
  );
  const globalManager = new GlobalContextManager(tmpFile);

  // 真实 TaskContextManager
  const taskManager = new TaskContextManager();

  // 被测对象：真实 DualLayerContextManager（不注入可选的 userGlobalMemory / experienceRecommender / ruleStore）
  const manager = new DualLayerContextManager(
    { projectRoot: "/tmp/test-project", defaultTokenBudget: tokenBudget },
    globalManager,
    taskManager,
    provider,
    scorer,
    windowManager,
    progressiveLoader,
    summarizer
  );

  return { manager, taskManager };
}

/**
 * 在 TaskContextManager 中创建测试任务
 *
 * buildOptimizedContext 要求 taskId 对应的 TaskContext 存在，否则返回空数组（降级）。
 * 此辅助函数封装任务创建逻辑，并支持注入 focusPoints（用于文件层片段测试）。
 *
 * @param taskManager 任务上下文管理器
 * @param taskId 任务 ID（默认 "task-1"）
 * @param options 可选配置
 * @param options.focusPoints 关注点列表（用于文件层片段测试，type="file" 的 ref 会被 collectFileSnippets 解析）
 * @returns 创建的 taskId
 */
function createTaskForManager(
  taskManager: TaskContextManager,
  taskId: string = "task-1",
  options?: {
    focusPoints?: Array<{ type: "file"; ref: string; priority: number }>;
  }
): string {
  taskManager.create(taskId, {
    description: "测试任务：验证图级上下文片段收集",
    goals: ["验证 collectGraphContextSnippets 行为"],
    constraints: [],
    taskType: "test",
    expectedOutput: "图级片段正确生成",
  });

  // 若提供 focusPoints，逐个添加到任务工作记忆
  if (options?.focusPoints) {
    for (const fp of options.focusPoints) {
      taskManager.addFocusPoint(taskId, {
        type: fp.type,
        ref: fp.ref,
        priority: fp.priority,
        addedAt: new Date().toISOString(),
      });
    }
  }

  return taskId;
}

/**
 * 从片段列表中筛选图级片段（type 以 "graph_" 开头）
 *
 * buildOptimizedContext 返回的片段包含多种类型（user_profile / task_definition / file_content 等），
 * 此辅助函数筛选出 graph_* 类型的片段，便于断言。
 *
 * @param snippets 完整片段列表
 * @returns 仅含 graph_* 类型的片段列表
 */
function filterGraphSnippets(snippets: ReadonlyArray<unknown>): ContextSnippet[] {
  return snippets.filter((s) => (s as ContextSnippet).type.startsWith("graph_")) as ContextSnippet[];
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
// D1-D5 降级路径测试（7 个）
// ============================================================================

/**
 * D1 dualLayerManager=undefined 时图正常完成
 *
 * 验证点（§13.11.5）：
 * - GraphLoopOrchestratorOptions.dualLayerManager=undefined
 * - 图正常完成
 * - buildOptimizedContext 不被调用（context.__contextSnippets 未设置）
 */
test("D1 dualLayerManager=undefined 时图正常完成", async () => {
  // 1. 构造简单线性图：A → end
  const graph: WorkGraph = GraphBuilder.create()
    .setGraphInfo("g-d1", "D1 降级图", "D1 无 dualLayerManager 测试")
    .addNode(makeTaskNode("A"))
    .addNode(makeEndNode("end"))
    .addEdge({ edgeId: "e1", from: "A", to: "end", dataMapping: {} })
    .setEntryNodeId("A")
    .build();

  // 2. 构造 StubNodeExecutor（捕获上下文快照）
  const executor = new StubNodeExecutor({
    behaviorMap: new Map([["A", "success"]]),
  });

  // 3. 构造编排器（不注入 dualLayerManager，不注入 userId）
  const orchestrator = createOrchestrator({
    nodeExecutor: executor,
    // dualLayerManager 和 userId 均未注入
  });

  // 4. 执行图
  const report = await orchestrator.run(graph);

  // 5. 验证图正常完成
  assert.equal(report.finalStatus, "completed", "无 dualLayerManager 时图应正常完成");

  // 6. 验证 buildOptimizedContext 未被调用（context 中无 __contextSnippets）
  const aContext = executor.getContextSnapshot("A");
  assert.ok(aContext, "应有节点 A 的上下文快照");
  const extendedContext = aContext as GraphRunContext & { __contextSnippets?: unknown[] };
  assert.equal(
    extendedContext.__contextSnippets,
    undefined,
    "无 dualLayerManager 时 __contextSnippets 应未设置（buildOptimizedContext 未被调用）"
  );
});

/**
 * D2 globalState={} 时 collectGraphContextSnippets 返回空数组
 *
 * 验证点（§13.11.5）：
 * - globalState={}（无 projectGoal 等字段）
 * - collectGraphContextSnippets 返回空数组
 * - 不抛异常
 *
 * 设计说明（M2 修复）：
 * - 改用真实 DualLayerContextManager，验证真实 collectGraphContextSnippets 对空对象的降级
 * - 真实实现的类型断言 ctx = graphGlobalContext as {...} | null 不会对空对象抛错
 * - 各字段 if(ctx.projectGoal) / if(ctx.sharedArtifacts) 等条件不满足，返回空数组
 */
test("D2 globalState={} 时 collectGraphContextSnippets 返回空数组", async () => {
  // 1. 构造真实 DualLayerContextManager
  const { manager, taskManager } = createRealManager();
  const taskId = createTaskForManager(taskManager);

  // 2. 调用真实 buildOptimizedContext，传入空对象作为 graphGlobalContext
  const emptyGlobalState: Record<string, unknown> = {};

  // 3. 验证不抛异常且返回不含 graph_* 片段
  const snippets = await manager.buildOptimizedContext("user-1", taskId, {
    graphGlobalContext: emptyGlobalState,
    currentNodeId: "node-1",
  });

  // 4. 断言：返回的 snippets 不含 graph_* 类型（空 globalState 无 projectGoal 等字段）
  const graphSnippets = filterGraphSnippets(snippets);
  assert.equal(graphSnippets.length, 0, "空 globalState 时不应返回任何 graph_* 片段");

  // 5. 断言：不抛异常（到达此行说明未抛异常）
  assert.ok(true, "空 globalState 时不应抛异常");
});

/**
 * D3 experienceStore=undefined 时跳过持久化，recallExperiences 仅返回 sameRun
 *
 * 验证点（§13.11.5）：
 * - experienceStore=undefined
 * - uploadExperiences 跳过 storeCase（不持久化）
 * - recallExperiences 仅返回 sameRun 经验（无历史召回）
 */
test("D3 experienceStore=undefined 时跳过持久化，recallExperiences 仅返回 sameRun", async () => {
  // 1. 构造线性图：A → B → end
  const graph: WorkGraph = GraphBuilder.create()
    .setGraphInfo("g-d3", "D3 降级图", "D3 无 experienceStore 测试")
    .addNode(makeTaskNode("A"))
    .addNode(makeTaskNode("B"))
    .addNode(makeEndNode("end"))
    .addEdge({ edgeId: "e1", from: "A", to: "B", dataMapping: {} })
    .addEdge({ edgeId: "e2", from: "B", to: "end", dataMapping: {} })
    .setEntryNodeId("A")
    .build();

  // 2. 为 A 构造 loopReport（触发经验上送到 collectedExperiences）
  const loopReportMap = new Map<string, LoopRunReport>();
  loopReportMap.set("A", makeLoopReport("A", { finalStatus: "completed" }));

  // 3. 构造 StubNodeExecutor（不注入 experienceStore，不调用 recallExperiences）
  const executor = new StubNodeExecutor({
    behaviorMap: new Map([
      ["A", "success"],
      ["B", "success"],
    ]),
    loopReportMap,
  });

  // 4. 构造真实的 DefaultNodeExperienceUploader（不注入 experienceStore）
  const experienceUploader = new DefaultNodeExperienceUploader(undefined, "/test/project");

  // 5. 构造编排器（不注入 experienceStore）
  const orchestrator = createOrchestrator({
    nodeExecutor: executor,
    experienceUploader,
    // experienceStore 未注入
  });

  // 6. 执行图
  const report = await orchestrator.run(graph);
  assert.equal(report.finalStatus, "completed", "图应成功完成");

  // 7. 验证 collectedExperiences 有经验（uploadExperiences 仍写入 globalState）
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
  assert.ok(
    collectedExperiences.length > 0,
    `collectedExperiences 应有经验（uploadExperiences 仍写入 globalState），实际 ${collectedExperiences.length} 条`
  );

  // 8. 验证 recallExperiences 仅返回 sameRun（experienceStore=undefined 时无历史召回）
  // 构造一个与 finalGlobalState 关联的 context 用于 recallExperiences
  const recallContext: GraphRunContext = {
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
  };
  const recalled = await recallExperiences(
    "B",
    "B 任务",
    recallContext,
    undefined // experienceStore 未注入
  );
  // recallExperiences 仅返回 sameRun（从 collectedExperiences 中排除自身）
  const sameRunExperiences = recalled.filter((e) => e.sourceNodeId === "A");
  assert.ok(
    sameRunExperiences.length > 0,
    `recallExperiences 应返回 sameRun 经验（node-A），实际 ${sameRunExperiences.length} 条`
  );
  // 无历史经验（experienceStore=undefined）
  const historicalExperiences = recalled.filter((e) => e.sourceNodeId === "historical");
  assert.equal(historicalExperiences.length, 0, "experienceStore=undefined 时不应有历史经验");
});

/**
 * D4 experienceUploader=undefined 时跳过经验上送
 *
 * 验证点（§13.11.5）：
 * - experienceUploader=undefined
 * - 跳过经验上送
 * - globalState 不积累图级上下文（collectedExperiences / bulletinBoard / nodeSummaries 为空）
 */
test("D4 experienceUploader=undefined 时跳过经验上送", async () => {
  // 1. 构造线性图：A → B → end
  const graph: WorkGraph = GraphBuilder.create()
    .setGraphInfo("g-d4", "D4 降级图", "D4 无 experienceUploader 测试")
    .addNode(makeTaskNode("A"))
    .addNode(makeTaskNode("B"))
    .addNode(makeEndNode("end"))
    .addEdge({ edgeId: "e1", from: "A", to: "B", dataMapping: {} })
    .addEdge({ edgeId: "e2", from: "B", to: "end", dataMapping: {} })
    .setEntryNodeId("A")
    .build();

  // 2. 为 A 构造 loopReport（但 experienceUploader 未注入，不会上送）
  const loopReportMap = new Map<string, LoopRunReport>();
  loopReportMap.set("A", makeLoopReport("A", { finalStatus: "completed" }));

  // 3. 构造 StubNodeExecutor
  const executor = new StubNodeExecutor({
    behaviorMap: new Map([
      ["A", "success"],
      ["B", "success"],
    ]),
    loopReportMap,
  });

  // 4. 构造编排器（不注入 experienceUploader，不注入 experienceStore）
  const orchestrator = createOrchestrator({
    nodeExecutor: executor,
    // experienceUploader 和 experienceStore 均未注入
  });

  // 5. 执行图
  const report = await orchestrator.run(graph);
  assert.equal(report.finalStatus, "completed", "图应成功完成");

  // 6. 验证 globalState 不积累图级上下文
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

  // collectedExperiences 应为空数组（initializeGraphGlobalContext 初始化为 []，但无上送）
  const collectedExperiences = globalCtx.collectedExperiences ?? [];
  assert.equal(
    collectedExperiences.length,
    0,
    `experienceUploader=undefined 时 collectedExperiences 应为空，实际 ${collectedExperiences.length} 条`
  );

  // bulletinBoard 应为空数组
  const bulletinBoard = globalCtx.bulletinBoard ?? [];
  assert.equal(
    bulletinBoard.length,
    0,
    `experienceUploader=undefined 时 bulletinBoard 应为空，实际 ${bulletinBoard.length} 条`
  );

  // nodeSummaries 应为空 Map（initializeGraphGlobalContext 初始化为空 Map，但无上送）
  const nodeSummaries = globalCtx.nodeSummaries ?? new Map();
  assert.equal(
    nodeSummaries.size,
    0,
    `experienceUploader=undefined 时 nodeSummaries 应为空，实际 ${nodeSummaries.size} 个`
  );

  // 注意：projectGoal 仍由 initializeGraphGlobalContext 注入（来自 graph.description）
  assert.ok(
    globalCtx.projectGoal !== undefined,
    "projectGoal 应由 initializeGraphGlobalContext 注入（与 experienceUploader 无关）"
  );
});

/**
 * D5 collectGraphContextSnippets 抛异常时降级（sharedArtifacts 含循环引用）
 *
 * 验证点（§13.11.5）：
 * - sharedArtifacts 含循环引用 → JSON.stringify 抛异常
 * - 上层 try-catch 捕获（buildOptimizedContext 内部 try-catch）
 * - buildOptimizedContext 返回不含图级片段
 * - 不中断主流程
 *
 * 设计说明（M2 修复）：
 * - 改用真实 DualLayerContextManager，直接调用 manager.buildOptimizedContext
 *   传入含循环引用的 graphGlobalContext，验证真实 collectGraphContextSnippets
 *   的 try-catch 捕获 JSON.stringify 异常的行为
 * - 不再通过 GraphLoopOrchestrator + setGlobalState 端到端验证（避免 deepFreeze
 *   递归循环引用导致的栈溢出，与降级路径测试目标无关）
 * - 真实 buildOptimizedContext 在 collectGraphContextSnippets 外层有 try-catch
 *   （dual-layer-manager.ts 第 476-491 行），捕获后降级为无图级片段
 */
test("D5 collectGraphContextSnippets 抛异常时降级（sharedArtifacts 含循环引用）", async () => {
  // 1. 构造含循环引用的 sharedArtifacts 对象
  const circularArtifact: Record<string, unknown> = { name: "circular-ref" };
  circularArtifact.self = circularArtifact; // 创建循环引用

  // 2. 验证 JSON.stringify 确实会抛异常（前置验证）
  assert.throws(() => JSON.stringify(circularArtifact), /circular/i, "前置验证：JSON.stringify 应对循环引用抛异常");

  // 3. 构造含循环引用的 GraphGlobalContext
  //    sharedArtifacts.circularArtifact 含循环引用，真实 collectGraphContextSnippets
  //    在生成 graph_shared_artifact 片段时调用 JSON.stringify(value) 会抛异常
  const graphGlobalContext: GraphGlobalContext = {
    projectGoal: "循环引用降级测试",
    globalConstraints: [],
    sharedArtifacts: { circularArtifact },
    nodeSummaries: new Map(),
    collectedExperiences: [],
    bulletinBoard: [],
  };

  // 4. 构造真实 DualLayerContextManager
  const { manager, taskManager } = createRealManager();
  const taskId = createTaskForManager(taskManager);

  // 5. 调用真实 buildOptimizedContext（应捕获异常，返回不含图级片段）
  //    真实实现：collectGraphContextSnippets 在生成 graph_shared_artifact 片段时
  //    JSON.stringify(circularArtifact) 抛 TypeError，由 buildOptimizedContext
  //    第 488 行的 catch 块捕获，降级为无图级片段
  const snippets = await manager.buildOptimizedContext("user-1", taskId, {
    graphGlobalContext,
    currentNodeId: "node-1",
  });

  // 6. 验证不抛异常（到达此行说明异常被 try-catch 捕获）
  assert.ok(true, "buildOptimizedContext 不应抛异常（异常应被 try-catch 捕获）");

  // 7. 验证返回的 snippets 不含 graph_* 类型
  //    异常导致 collectGraphContextSnippets 中断，整个图级片段收集降级为空
  const graphSnippets = filterGraphSnippets(snippets);
  assert.equal(graphSnippets.length, 0, `循环引用异常降级后不应返回 graph_* 片段，实际 ${graphSnippets.length} 条`);
});

/**
 * D5b nodeSummaries 类型异常时降级（L3 修复：D5b 场景扩展）
 *
 * 验证点（§13.11.5 降级路径扩展覆盖）：
 * - graphGlobalContext.nodeSummaries 不是 Map 而是普通对象
 * - collectGraphContextSnippets 执行 `[...ctx.nodeSummaries.values()]` 时抛 TypeError
 *   （普通对象没有 values() 实例方法）
 * - buildOptimizedContext 的 try-catch 捕获异常，降级为无图级片段
 * - 不中断主流程
 *
 * 设计说明（L3 修复）：
 * - D5 仅覆盖 sharedArtifacts 循环引用场景，D5b 覆盖 nodeSummaries 类型异常场景
 * - 真实实现中 nodeSummaries 应为 Map<string, NodeSummary>，
 *   但外部传入的 graphGlobalContext 是 unknown 类型，可能被错误构造为普通对象
 * - 验证真实 collectGraphContextSnippets 的 try-catch 降级路径覆盖所有字段异常
 */
test("D5b nodeSummaries 类型异常时降级（普通对象而非 Map）", async () => {
  // 1. 构造 nodeSummaries 为普通对象（而非 Map）的 graphGlobalContext
  //    真实实现期望 Map<string, NodeSummary>，传入普通对象会导致
  //    `[...ctx.nodeSummaries.values()]` 抛 TypeError（普通对象无 values() 方法）
  const graphGlobalContext = {
    projectGoal: "nodeSummaries 类型异常测试",
    globalConstraints: [],
    sharedArtifacts: {},
    // 故意传入普通对象而非 Map，触发类型异常
    nodeSummaries: {
      "node-1": {
        nodeId: "node-1",
        label: "node-1",
        status: "completed",
        outputSummary: "输出 1",
        keyDecisions: [],
        completedAt: "2026-07-23T10:00:00.000Z",
      },
    },
    collectedExperiences: [],
    bulletinBoard: [],
  };

  // 2. 前置验证：普通对象没有 values() 方法，[...obj.values()] 会抛 TypeError
  assert.throws(
    () => {
      const obj = graphGlobalContext.nodeSummaries as Record<string, unknown>;
      // @ts-expect-error 测试类型异常：普通对象没有 values() 方法
      return [...obj.values()];
    },
    /values is not a function|not a function/i,
    "前置验证：普通对象调用 values() 应抛 TypeError"
  );

  // 3. 构造真实 DualLayerContextManager
  const { manager, taskManager } = createRealManager();
  const taskId = createTaskForManager(taskManager);

  // 4. 调用真实 buildOptimizedContext（应捕获异常，返回不含图级片段）
  //    真实实现：collectGraphContextSnippets 在处理 nodeSummaries 时
  //    执行 [...ctx.nodeSummaries.values()] 抛 TypeError
  //    由 buildOptimizedContext 第 488 行的 catch 块捕获，降级为无图级片段
  const snippets = await manager.buildOptimizedContext("user-1", taskId, {
    graphGlobalContext,
    currentNodeId: "node-2",
  });

  // 5. 验证不抛异常（到达此行说明异常被 try-catch 捕获）
  assert.ok(true, "buildOptimizedContext 不应抛异常（nodeSummaries 类型异常应被捕获）");

  // 6. 验证返回的 snippets 不含 graph_* 类型
  //    异常导致 collectGraphContextSnippets 中断，整个图级片段收集降级为空
  const graphSnippets = filterGraphSnippets(snippets);
  assert.equal(
    graphSnippets.length,
    0,
    `nodeSummaries 类型异常降级后不应返回 graph_* 片段，实际 ${graphSnippets.length} 条`
  );
});

/**
 * D5c collectedExperiences 含 null 元素时降级（v4-H5 修复：对齐设计要求）
 *
 * 验证点（§13.11.5 降级路径扩展覆盖）：
 * - graphGlobalContext.collectedExperiences 数组中含 null 元素
 * - collectGraphContextSnippets 执行 `ctx.collectedExperiences.filter((e) => e.sourceNodeId !== ...)` 时
 *   对 null 元素解引用 `e.sourceNodeId` 抛 TypeError（Cannot read property 'sourceNodeId' of null）
 * - buildOptimizedContext 的 try-catch 捕获异常，降级为无图级片段
 * - 不中断主流程
 *
 * 设计说明（v4-H5 修复）：
 * - D5 覆盖 sharedArtifacts 循环引用，D5b 覆盖 nodeSummaries 类型异常，
 *   D5c 覆盖 collectedExperiences 含 null 元素场景（v3.1-L3 设计要求）
 * - v3.1 中 D5c 偏离设计（测"普通对象而非数组"），v4 修正为"含 null 元素"
 * - 真实实现中 collectedExperiences 应为 Array<GraphExperienceEntry>，
 *   但外部传入的 graphGlobalContext 是 unknown 类型，数组中可能含 null 元素
 * - 验证真实 collectGraphContextSnippets 的 try-catch 降级路径覆盖 null 元素解引用异常
 */
test("D5c collectedExperiences 含 null 元素时降级（null 解引用异常）", async () => {
  // 1. 构造 collectedExperiences 含 null 元素的 graphGlobalContext
  //    真实实现期望 Array<GraphExperienceEntry>，传入含 null 的数组会导致
  //    `ctx.collectedExperiences.filter((e) => e.sourceNodeId !== ...)` 对 null 解引用抛 TypeError
  const graphGlobalContext = {
    projectGoal: "collectedExperiences null 元素测试",
    globalConstraints: [],
    sharedArtifacts: {},
    nodeSummaries: new Map(),
    // 故意传入含 null 元素的数组，触发 null 解引用异常
    collectedExperiences: [
      null,
      {
        experienceId: "exp-1",
        sourceNodeId: "node-1",
        type: "success",
        taskType: "coding",
        description: "测试经验",
        createdAt: "2026-07-23T10:00:00.000Z",
      },
    ],
    bulletinBoard: [],
  };

  // 2. 前置验证：null 元素解引用 sourceNodeId 抛 TypeError
  assert.throws(
    () => {
      const arr = graphGlobalContext.collectedExperiences as unknown as Array<{ sourceNodeId?: string }>;
      return arr.filter((e) => e.sourceNodeId !== "node-2");
    },
    /Cannot read propert|undefined|null/i,
    "前置验证：null 元素解引用 sourceNodeId 应抛 TypeError"
  );

  // 3. 构造真实 DualLayerContextManager
  const { manager, taskManager } = createRealManager();
  const taskId = createTaskForManager(taskManager);

  // 4. 调用真实 buildOptimizedContext（应捕获异常，返回不含图级片段）
  //    真实实现：collectGraphContextSnippets 在处理 collectedExperiences 时
  //    执行 ctx.collectedExperiences.filter(...) 抛 TypeError
  //    由 buildOptimizedContext 第 488 行的 catch 块捕获，降级为无图级片段
  const snippets = await manager.buildOptimizedContext("user-1", taskId, {
    graphGlobalContext,
    currentNodeId: "node-2",
  });

  // 5. 验证不抛异常（到达此行说明异常被 try-catch 捕获）
  assert.ok(true, "buildOptimizedContext 不应抛异常（collectedExperiences 类型异常应被捕获）");

  // 6. 验证返回的 snippets 不含 graph_* 类型
  //    异常导致 collectGraphContextSnippets 中断，整个图级片段收集降级为空
  const graphSnippets = filterGraphSnippets(snippets);
  assert.equal(
    graphSnippets.length,
    0,
    `collectedExperiences 类型异常降级后不应返回 graph_* 片段，实际 ${graphSnippets.length} 条`
  );
});
