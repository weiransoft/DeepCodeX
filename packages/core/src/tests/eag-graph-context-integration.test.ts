/**
 * EAG-Graph 上下文集成测试（对齐设计文档 §13.12.3）
 *
 * 测试范围：
 * - I1.* 图级片段注入到 buildOptimizedContext 的集成测试（3 个）
 *   验证 GraphGlobalContext 中的 projectGoal / nodeSummaries 等字段被正确收集为
 *   graph_project_goal / graph_node_summary 片段，并按 directRetain / scoringCandidates
 *   两条通道注入到 buildOptimizedContext 返回值中。
 * - E2.* 端到端集成测试（4 个）
 *   验证真实 GraphLoopOrchestrator + 真实 ExperienceStoreImpl + 真实 DefaultNodeExperienceUploader
 *   的完整闭环：经验上送 → collectedExperiences 积累 → recallExperiences 召回 →
 *   fork 并行分支合并 → 图级上下文通过 context 传递到 NodeExecutor。
 * - D1-D5 降级路径测试（5 个）
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
 * - LOOP-GRAPH-FUSION-DESIGN.md §13.12.3 I1.* / E2.* / D1-D5 测试用例定义
 * - §13.8.3 图级片段注入 buildOptimizedContext
 * - §13.9.1 GraphGlobalContext 初始化
 * - §13.9.2 经验上送与动向广播
 * - §13.9.3 图级上下文通过 context 传递到 NodeExecutor
 * - §13.11.1 Token 预算控制
 * - §13.11.5 降级路径
 * - §13.11.6 并行合并
 *
 * @module core/tests/eag-graph-context-integration
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
import { ExperienceStoreImpl } from "../eag/graph/experience-store";
import {
  DEFAULT_WORK_GRAPH_CONFIG,
  createRetrySuppressionConfig,
  getGraphGlobalContext,
} from "../eag/graph/graph-loop-models";
// H4 修复：导入真实 DualLayerContextManager 及其依赖（对齐 §13.12.3 I1.1 真实组件要求）
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

// ============================================================================
// 辅助：构造测试数据（复用 eag-graph-orchestrator.test.ts 的风格）
// ============================================================================

/**
 * 构造一个 task 节点定义
 *
 * @param nodeId 节点 ID
 * @param outputContract 输出契约（可选，默认空数组）
 * @param inputContract 输入契约（可选，默认空数组）
 * @returns task 类型的 GraphNodeDef 实例
 */
function makeTaskNode(
  nodeId: string,
  outputContract: ReadonlyArray<NodeFieldContract> = [],
  inputContract: ReadonlyArray<NodeFieldContract> = []
): GraphNodeDef {
  return {
    nodeId,
    nodeType: "task",
    label: nodeId,
    task: `${nodeId} 任务`,
    inputContract,
    outputContract,
    plugin: "echo",
  };
}

/**
 * 构造一个 end 节点定义
 *
 * @param nodeId 节点 ID
 * @returns end 类型的 GraphNodeDef 实例
 */
function makeEndNode(nodeId: string): GraphNodeDef {
  return {
    nodeId,
    nodeType: "end",
    label: nodeId,
    task: "结束节点",
    inputContract: [],
    outputContract: [],
  };
}

/**
 * 构造一个 fork 节点定义（并行派发节点）
 *
 * @param nodeId 节点 ID
 * @returns fork 类型的 GraphNodeDef 实例
 */
function makeForkNode(nodeId: string): GraphNodeDef {
  return {
    nodeId,
    nodeType: "fork",
    label: nodeId,
    task: `${nodeId} 并行派发`,
    inputContract: [],
    outputContract: [],
  };
}

/**
 * 构造一个 merge 节点定义（汇聚节点）
 *
 * @param nodeId 节点 ID
 * @returns merge 类型的 GraphNodeDef 实例
 */
function makeMergeNode(nodeId: string): GraphNodeDef {
  return {
    nodeId,
    nodeType: "merge",
    label: nodeId,
    task: `${nodeId} 合并`,
    inputContract: [],
    outputContract: [],
  };
}

/**
 * 创建不输出日志的 GraphLogger（测试用，避免噪音）
 *
 * @returns GraphLogger 实例（所有日志方法均为空实现）
 */
function makeSilentLogger(): GraphLogger {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

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
 * - 实现NodeExecutorProtocol 协议，支持按节点 ID 配置成功/失败行为
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
// E2.* 端到端集成测试（4 个）
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

// ============================================================================
// D1-D5 降级路径测试（5 个）
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
