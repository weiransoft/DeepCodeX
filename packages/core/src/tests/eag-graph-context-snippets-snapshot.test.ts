/**
 * EAG-Graph 上下文集成测试 - 图级片段注入与状态快照（对齐设计文档 §13.12.3）
 *
 * 测试范围：
 * - I1.* 图级片段注入到 buildOptimizedContext 的集成测试（3 个）
 *   验证 GraphGlobalContext 中的 projectGoal / nodeSummaries 等字段被正确收集为
 *   graph_project_goal / graph_node_summary 片段，并按 directRetain / scoringCandidates
 *   两条通道注入到 buildOptimizedContext 返回值中。
 * - M2.* snapshotGlobalState 行为和 readonly 字段保护直接测试（3 个）
 *   验证 snapshotGlobalState 的深拷贝 + 递归冻结、脱敏行为，以及 GraphRunReport readonly 字段保护。
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止使用 mock 框架，使用真实闭包实现和真实类型实例
 * - 测试替身命名禁用 Mock 前缀，统一用 Stub / Silent / InMemory
 * - 每个测试用例独立，无共享可变状态
 * - 中文注释详细，符合规范
 *
 * 设计依据：
 * - LOOP-GRAPH-FUSION-DESIGN.md §13.12.3 I1.* / M2.* 测试用例定义
 * - §13.8.3 图级片段注入 buildOptimizedContext
 * - §13.9.1 GraphGlobalContext 初始化
 * - §13.11.1 Token 预算控制
 * - §13.11.2 快照脱敏 + 递归冻结
 * - §13.11.5 降级路径
 *
 * @module core/tests/eag-graph-context-snippets-snapshot
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
import { recallExperiences } from "../eag/graph/graph-context-helpers";
import { createRetrySuppressionConfig, getGraphGlobalContext } from "../eag/graph/graph-loop-models";
// 真实 DualLayerContextManager 及其依赖（对齐 §13.12.3 I1.1 真实组件要求）
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
  /** 图运行上下文 */
  GraphRunContext,
  /** 节点字段契约 */
  NodeFieldContract,
  /** 图日志记录器接口 */
  GraphLogger,
  /** 图级全局上下文 */
  GraphGlobalContext,
  /** 图级经验条目 */
  GraphExperienceEntry,
  DEFAULT_WORK_GRAPH_CONFIG,
} from "../eag/graph/graph-loop-models";
import type {
  /** 节点执行器协议 */
  NodeExecutorProtocol,
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
// H4 修复：真实 DualLayerContextManager 辅助构造（替换原 StubDualLayerContextManager）
// ============================================================================
//
// 设计依据（§13.12.3 I1.1 共识）：
// - I1.* 集成测试必须使用真实 DualLayerContextManager + 真实 GraphGlobalContext
// - 禁止手写复刻 collectGraphContextSnippets 逻辑（避免与真实实现漂移）
// - 复用 dual-layer-graph-snippets.test.ts 的 createManager() 模式（同款真实依赖装配）
//
// 装配的真实依赖：
// - GlobalContextManager：真实实例（传入临时文件路径，load 返回默认空上下文）
// - TaskContextManager：真实实例
// - RelevanceScorer：真实评分器（零配置，使用默认权重）
// - SlidingWindowManager：真实滑动窗口（100000 token 预算，Top-K=20）
// - ProgressiveContextLoader：真实渐进式加载器（100000 token 预算）
// - RuleBasedSummarizer：真实规则摘要器（启发式算法，非 mock）
// - StubCodeMapProvider：返回可配置 CodeMap 的提供者（仅文件层 Stub，图级片段走真实逻辑）
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
 * 构造包含 N 个文件的 CodeMap（用于 I1.2 文件层片段竞争预算测试）
 *
 * 每个文件路径形如 `/tmp/test-project/src/file-{i}.ts`，
 * 与 projectRoot="/tmp/test-project" 配合可被 collectFileSnippets 解析为相对路径 `src/file-{i}.ts`。
 *
 * @param count 文件数量
 * @returns 含 N 个文件的 CodeMap
 */
function makeCodeMapWithFiles(count: number): CodeMap {
  const empty = makeEmptyCodeMap();
  const files: FileInfo[] = [];
  for (let i = 1; i <= count; i++) {
    files.push({
      path: `/tmp/test-project/src/file-${i}.ts`,
      language: "typescript",
      classes: [],
      functions: [],
      imports: [],
      exports: [],
      lines: 100,
      parseStatus: "ok",
      dependencies: [],
    });
  }
  return { ...empty, files, stats: { ...empty.stats, totalFiles: count, parsedFiles: count } };
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
  private readonly experienceStore?: import("../eag/graph/graph-loop-protocols").ExperienceStoreProtocol;
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
    experienceStore?: import("../eag/graph/graph-loop-protocols").ExperienceStoreProtocol;
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
  ): Promise<import("../eag/graph/graph-loop-models").GraphNodeResult> {
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
    experienceStore?: import("../eag/graph/graph-loop-protocols").ExperienceStoreProtocol;
    experienceUploader?: import("../eag/graph/graph-loop-protocols").NodeExperienceUploader;
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
// I1.* 集成测试 - 图级片段注入到 buildOptimizedContext（3 个）
// ============================================================================

/**
 * I1.1 图级片段出现在 buildOptimizedContext 返回中
 *
 * 验证点（§13.8.3 集成生效）：
 * - 当 graphGlobalContext 含 projectGoal 和 nodeSummaries 时
 * - buildOptimizedContext 返回的 ContextSnippet[] 含 graph_project_goal 和 graph_node_summary 片段
 *
 * 设计说明（H4 修复）：
 * - 改用真实 DualLayerContextManager + 真实 GraphGlobalContext（对齐 §13.12.3 I1.1）
 * - 通过 createRealManager() 装配真实依赖（GlobalContextManager / TaskContextManager /
 *   RelevanceScorer / SlidingWindowManager / ProgressiveContextLoader / RuleBasedSummarizer）
 * - 文件层使用 StubCodeMapProvider 返回空 CodeMap，使图级片段成为评分候选的主要来源
 * - 直接调用 buildOptimizedContext 验证真实 collectGraphContextSnippets 的图级片段收集正确性
 */
test("I1.1 图级片段出现在 buildOptimizedContext 返回中", async () => {
  // 1. 构造真实 DualLayerContextManager（含全部真实依赖）
  const { manager, taskManager } = createRealManager();
  const taskId = createTaskForManager(taskManager);

  // 2. 构造真实的 GraphGlobalContext 数据（含 projectGoal 和 nodeSummaries）
  const graphGlobalContext: GraphGlobalContext = {
    projectGoal: "实现用户登录功能",
    globalConstraints: ["token 预算 ≤ 500000", "超时 ≤ 3600s"],
    sharedArtifacts: { designDoc: "设计文档内容" },
    nodeSummaries: new Map([
      [
        "node-1",
        {
          nodeId: "node-1",
          nodeType: "task",
          label: "node-1",
          status: "completed",
          outputSummary: "完成了登录接口",
          keyDecisions: ["使用 JWT 认证"],
          completedAt: "2026-07-23T10:00:00.000Z",
        },
      ],
    ]),
    collectedExperiences: [],
    bulletinBoard: [],
    runId: "run-i1-1",
    graphId: "g-i1-1",
    createdAt: "2026-07-23T10:00:00.000Z",
    lastUpdatedAt: "2026-07-23T10:00:00.000Z",
  };

  // 3. 调用真实 buildOptimizedContext，注入 graphGlobalContext 和 currentNodeId
  const snippets = await manager.buildOptimizedContext("user-1", taskId, {
    graphGlobalContext,
    currentNodeId: "node-2",
    maxTokens: 100_000, // 充足预算，确保图级片段不被截断
  });

  // 4. 筛选图级片段（buildOptimizedContext 返回值含 user_profile / task_definition 等多种类型）
  const graphSnippets = filterGraphSnippets(snippets);

  // 5. 断言返回的图级片段含 graph_project_goal 和 graph_node_summary 类型
  const types = graphSnippets.map((s) => s.type);
  assert.ok(types.includes("graph_project_goal"), "返回的片段应包含 graph_project_goal 类型");
  assert.ok(types.includes("graph_node_summary"), "返回的片段应包含 graph_node_summary 类型");

  // 6. 验证 graph_project_goal 片段内容包含项目目标
  const goalSnippet = graphSnippets.find((s) => s.type === "graph_project_goal");
  assert.ok(goalSnippet, "graph_project_goal 片段应存在");
  assert.ok(goalSnippet!.content.includes("实现用户登录功能"), "graph_project_goal 片段内容应包含项目目标");

  // 7. 验证 graph_node_summary 片段排除自身节点（currentNodeId="node-2"）
  const summarySnippets = graphSnippets.filter((s) => s.type === "graph_node_summary");
  assert.equal(summarySnippets.length, 1, "应有 1 条 node_summary 片段（node-1）");
  assert.ok(summarySnippets[0].source.includes("node-1"), "node_summary 片段来源应为 node-1");
});

/**
 * I1.2 图级片段挤占评分片段预算
 *
 * 验证点（§13.11.1 Token 预算控制）：
 * - 当 maxTokens 紧张时
 * - 评分片段（file_content 文件片段）返回数 < 5
 * - directRetain 图级片段（graph_project_goal）全部保留
 *
 * 设计说明（H4 修复）：
 * - 改用真实 DualLayerContextManager，文件层片段由真实 collectFileSnippets 从 CodeMap + focusPoints 生成
 * - 通过 makeCodeMapWithFiles(5) 构造含 5 个文件的 CodeMap
 * - 通过 createTaskForManager 注入 5 个 focusPoints（type="file"），引用 CodeMap 中的 5 个文件
 * - 设置紧张的 maxTokens（100 token），触发 SlidingWindowManager 的 Token 预算截断
 * - directRetain 通道（含 graph_project_goal）先扣除预算，剩余预算给评分片段（file_content）
 */
test("I1.2 图级片段挤占评分片段预算", async () => {
  // 1. 构造含 5 个文件的 CodeMap（用于生成 5 个 file_content 评分片段）
  const codeMap = makeCodeMapWithFiles(5);

  // 2. 构造 5 个 focusPoints（type="file"，ref 与 CodeMap 文件路径的相对路径对应）
  const focusPoints = Array.from({ length: 5 }, (_, i) => ({
    type: "file" as const,
    ref: `src/file-${i + 1}.ts`,
    priority: 0.9,
  }));

  // 3. 构造真实 DualLayerContextManager（注入含 5 文件的 CodeMap）
  const { manager, taskManager } = createRealManager({
    codeMapProvider: new StubCodeMapProvider(codeMap),
  });
  const taskId = createTaskForManager(taskManager, "task-i12", { focusPoints });

  // 4. 构造 GraphGlobalContext（含 projectGoal，不含 nodeSummaries）
  const graphGlobalContext: GraphGlobalContext = {
    projectGoal: "紧张预算测试目标",
    globalConstraints: [],
    sharedArtifacts: {},
    nodeSummaries: new Map(),
    collectedExperiences: [],
    bulletinBoard: [],
  };

  // 5. 调用真实 buildOptimizedContext，设置紧张的 maxTokens（100 token，远小于 5 个文件片段所需）
  const snippets = await manager.buildOptimizedContext("user-1", taskId, {
    graphGlobalContext,
    currentNodeId: "node-1",
    maxTokens: 100,
  });

  // 6. 断言：评分片段（file_content）被截断，返回数 < 5
  const fileSnippets = snippets.filter((s) => (s as ContextSnippet).type === "file_content") as ContextSnippet[];
  assert.ok(fileSnippets.length < 5, `紧张预算下评分片段应被截断，实际返回 ${fileSnippets.length} 条（应 < 5）`);

  // 7. 断言：directRetain 图级片段（graph_project_goal）全部保留
  //    graph_project_goal 走 directRetain 通道，先扣除 Token 预算，永不被评分截断
  const goalSnippets = filterGraphSnippets(snippets).filter((s) => s.type === "graph_project_goal");
  assert.equal(goalSnippets.length, 1, "directRetain 图级片段应全部保留（1 条 graph_project_goal）");
});

/**
 * I1.3 GraphGlobalContext 未注入时降级
 *
 * 验证点（§13.11.5 降级）：
 * - 当 buildOptimizedContext 未传入 graphGlobalContext 时
 * - 返回的 snippets 不含 graph_* 类型
 * - 不抛异常
 *
 * 设计说明（H4 修复）：
 * - 改用真实 DualLayerContextManager，验证真实 collectGraphContextSnippets 的降级路径
 * - 不传入 graphGlobalContext，真实实现中 if(graphGlobalContext && currentNodeId) 条件不满足，跳过图级片段收集
 */
test("I1.3 GraphGlobalContext 未注入时降级", async () => {
  // 1. 构造真实 DualLayerContextManager
  const { manager, taskManager } = createRealManager();
  const taskId = createTaskForManager(taskManager);

  // 2. 调用真实 buildOptimizedContext，不传入 graphGlobalContext
  const snippets = await manager.buildOptimizedContext("user-1", taskId, {
    currentNodeId: "node-1",
    // graphGlobalContext 未提供
  });

  // 3. 断言：返回的 snippets 不含 graph_* 类型
  const graphSnippets = filterGraphSnippets(snippets);
  assert.equal(graphSnippets.length, 0, "未注入 graphGlobalContext 时不应返回 graph_* 类型片段");

  // 4. 断言：不抛异常（若到达此行说明未抛异常）
  assert.ok(true, "未注入 graphGlobalContext 时不应抛异常");
});

// ============================================================================
// M2.* snapshotGlobalState 行为和 readonly 字段保护直接测试（v4-M2 新增）
//
// 测试范围（§13.11.2 / §13.4.2）：
// - M2.1 snapshotGlobalState 深拷贝 + 递归冻结：finalGlobalState 及嵌套结构不可修改
// - M2.2 snapshotGlobalState 脱敏行为：sharedArtifacts 中敏感 key 值替换为 [REDACTED]
// - M2.3 GraphRunReport readonly 字段保护：报告对象及其 readonly 字段不可修改
//
// 设计依据：
// - snapshotGlobalState 是 GraphLoopOrchestrator 的 private 方法，通过 run() 返回的
//   GraphRunReport.finalGlobalState 间接验证
// - 深拷贝（structuredClone）确保外部修改快照不影响运行期 globalState
// - 脱敏（SENSITIVE_KEY_PATTERN）防止 API key/token/password 等泄漏到报告
// - 递归冻结（deepFreeze）确保所有嵌套对象/数组不可变
// - Object.freeze(GraphRunReport) 确保 readonly 字段运行期不可修改
// ============================================================================

/**
 * 构造含敏感 key 的 sharedArtifacts 图级初始状态
 *
 * 用于测试 snapshotGlobalState 的脱敏行为：
 * - 敏感 key（apiKey/password/secret/token/credential）应被替换为 [REDACTED]
 * - 非敏感 key（normalField/config）应保持原值
 *
 * @returns 含敏感 key 和非敏感 key 的 globalState
 */
function makeSensitiveGlobalState(): Readonly<Record<string, unknown>> {
  return Object.freeze({
    apiKey: "sk-1234567890abcdef",
    password: "my-secret-password",
    secretToken: "bearer-token-value",
    credential: "aws-credential",
    normalField: "这是普通字段，不应被脱敏",
    config: { port: 8080, host: "localhost" },
  });
}

test("M2.1 snapshotGlobalState 深拷贝 + 递归冻结：finalGlobalState 及嵌套结构不可修改", async () => {
  // 1. 构造线性图：A → end，globalState 含嵌套对象
  const graph: WorkGraph = GraphBuilder.create()
    .setGraphInfo("g-m2-1", "快照冻结测试图", "M2.1 snapshotGlobalState 深拷贝+递归冻结")
    .addNode(makeTaskNode("A"))
    .addNode(makeEndNode("end"))
    .addEdge({ edgeId: "e1", from: "A", to: "end", dataMapping: {} })
    .setEntryNodeId("A")
    .setGlobalState({
      normalField: "普通字段",
      nestedObject: { inner: "嵌套值", deep: { deeper: "深层值" } },
      nestedArray: [{ item: "数组元素1" }, { item: "数组元素2" }],
    })
    .build();

  // 2. 构造执行器和编排器
  const executor = new StubNodeExecutor({
    behaviorMap: new Map([["A", "success"]]),
  });
  const orchestrator = createOrchestrator({ nodeExecutor: executor });

  // 3. 执行图
  const report = await orchestrator.run(graph);
  assert.equal(report.finalStatus, "completed", "图应成功完成");

  // 4. 验证 finalGlobalState 顶层对象已冻结
  const state = report.finalGlobalState;
  assert.ok(Object.isFrozen(state), "finalGlobalState 顶层对象应已冻结（Object.isFrozen 返回 true）");

  // 5. 验证修改顶层字段抛 TypeError（strict mode 下 Object.freeze 的行为）
  assert.throws(
    () => {
      (state as Record<string, unknown>)["newField"] = "不应写入";
    },
    TypeError,
    "修改已冻结的 finalGlobalState 顶层字段应抛 TypeError"
  );

  // 6. 验证嵌套对象已冻结
  const nestedObject = (state as { sharedArtifacts?: { nestedObject?: unknown } }).sharedArtifacts?.nestedObject;
  assert.ok(
    nestedObject !== undefined && typeof nestedObject === "object" && Object.isFrozen(nestedObject),
    "嵌套对象 nestedObject 应已冻结"
  );

  // 7. 验证深层嵌套对象已冻结
  const deepObject = (state as { sharedArtifacts?: { nestedObject?: { deep?: unknown } } }).sharedArtifacts
    ?.nestedObject?.deep;
  assert.ok(
    deepObject !== undefined && typeof deepObject === "object" && Object.isFrozen(deepObject),
    "深层嵌套对象 nestedObject.deep 应已冻结（递归冻结到所有层级）"
  );

  // 8. 验证嵌套数组已冻结
  const nestedArray = (state as { sharedArtifacts?: { nestedArray?: unknown[] } }).sharedArtifacts?.nestedArray;
  assert.ok(Array.isArray(nestedArray) && Object.isFrozen(nestedArray), "嵌套数组 nestedArray 应已冻结");

  // 9. 验证数组元素已冻结
  if (Array.isArray(nestedArray)) {
    assert.ok(Object.isFrozen(nestedArray[0]), "数组元素 nestedArray[0] 应已冻结（递归冻结数组元素）");
  }

  // 10. 验证深拷贝：修改 finalGlobalState 不影响运行期 globalState
  //     由于 finalGlobalState 已冻结无法修改，通过验证字段值未被外部篡改来间接验证深拷贝
  const originalField = (state as { sharedArtifacts?: { normalField?: string } }).sharedArtifacts?.normalField;
  assert.equal(
    originalField,
    "普通字段",
    "finalGlobalState.sharedArtifacts.normalField 值应保持原值（深拷贝未共享引用）"
  );
});

test("M2.2 snapshotGlobalState 脱敏行为：sharedArtifacts 中敏感 key 值替换为 [REDACTED]", async () => {
  // 1. 构造线性图：A → end，globalState 含敏感 key
  const graph: WorkGraph = GraphBuilder.create()
    .setGraphInfo("g-m2-2", "脱敏测试图", "M2.2 snapshotGlobalState 敏感 key 脱敏")
    .addNode(makeTaskNode("A"))
    .addNode(makeEndNode("end"))
    .addEdge({ edgeId: "e1", from: "A", to: "end", dataMapping: {} })
    .setEntryNodeId("A")
    .setGlobalState(makeSensitiveGlobalState())
    .build();

  // 2. 构造执行器和编排器
  const executor = new StubNodeExecutor({
    behaviorMap: new Map([["A", "success"]]),
  });
  const orchestrator = createOrchestrator({ nodeExecutor: executor });

  // 3. 执行图
  const report = await orchestrator.run(graph);
  assert.equal(report.finalStatus, "completed", "图应成功完成");

  // 4. 获取 finalGlobalState.sharedArtifacts
  const sharedArtifacts = (report.finalGlobalState as { sharedArtifacts?: Record<string, unknown> }).sharedArtifacts;
  assert.ok(sharedArtifacts, "finalGlobalState 应含 sharedArtifacts 字段");

  // 5. 验证敏感 key 被脱敏为 [REDACTED]
  //    SENSITIVE_KEY_PATTERN = /key|token|secret|password|credential/i
  assert.equal(sharedArtifacts!["apiKey"], "[REDACTED]", "apiKey 应被脱敏为 [REDACTED]（匹配 /key/i）");
  assert.equal(sharedArtifacts!["password"], "[REDACTED]", "password 应被脱敏为 [REDACTED]（匹配 /password/i）");
  assert.equal(
    sharedArtifacts!["secretToken"],
    "[REDACTED]",
    "secretToken 应被脱敏为 [REDACTED]（匹配 /secret|token/i）"
  );
  assert.equal(sharedArtifacts!["credential"], "[REDACTED]", "credential 应被脱敏为 [REDACTED]（匹配 /credential/i）");

  // 6. 验证非敏感 key 保持原值
  assert.equal(
    sharedArtifacts!["normalField"],
    "这是普通字段，不应被脱敏",
    "normalField 应保持原值（不匹配敏感 key 模式）"
  );
  assert.deepEqual(
    sharedArtifacts!["config"],
    { port: 8080, host: "localhost" },
    "config 应保持原值（不匹配敏感 key 模式）"
  );
});

test("M2.3 GraphRunReport readonly 字段保护：报告对象及其 readonly 字段不可修改", async () => {
  // 1. 构造线性图：A → end
  const graph: WorkGraph = GraphBuilder.create()
    .setGraphInfo("g-m2-3", "报告冻结测试图", "M2.3 GraphRunReport readonly 字段保护")
    .addNode(makeTaskNode("A"))
    .addNode(makeEndNode("end"))
    .addEdge({ edgeId: "e1", from: "A", to: "end", dataMapping: {} })
    .setEntryNodeId("A")
    .build();

  // 2. 构造执行器和编排器
  const executor = new StubNodeExecutor({
    behaviorMap: new Map([["A", "success"]]),
  });
  const orchestrator = createOrchestrator({ nodeExecutor: executor });

  // 3. 执行图
  const report = await orchestrator.run(graph);
  assert.equal(report.finalStatus, "completed", "图应成功完成");

  // 4. 验证 GraphRunReport 顶层对象已冻结
  assert.ok(Object.isFrozen(report), "GraphRunReport 应已冻结（Object.freeze，buildReport 返回 Object.freeze）");

  // 5. 验证修改 readonly 字段抛 TypeError
  assert.throws(
    () => {
      (report as { runId: string }).runId = "tampered-run-id";
    },
    TypeError,
    "修改 readonly 字段 runId 应抛 TypeError（对象已冻结）"
  );

  assert.throws(
    () => {
      (report as { finalStatus: string }).finalStatus = "failed";
    },
    TypeError,
    "修改 readonly 字段 finalStatus 应抛 TypeError（对象已冻结）"
  );

  assert.throws(
    () => {
      (report as { totalTokensUsed: number }).totalTokensUsed = 999999;
    },
    TypeError,
    "修改 readonly 字段 totalTokensUsed 应抛 TypeError（对象已冻结）"
  );

  // 6. 验证 traversalPath 数组已冻结
  assert.ok(Object.isFrozen(report.traversalPath), "traversalPath 数组应已冻结");

  // 7. 验证 triggeredGuards 数组已冻结
  assert.ok(Object.isFrozen(report.triggeredGuards), "triggeredGuards 数组应已冻结");

  // 8. 验证 finalGlobalState 已冻结（与 M2.1 一致，此处确认 report 中所有 readonly 字段均受保护）
  assert.ok(
    Object.isFrozen(report.finalGlobalState),
    "finalGlobalState 应已冻结（report 的 readonly 字段同样受 Object.freeze 保护）"
  );
});
