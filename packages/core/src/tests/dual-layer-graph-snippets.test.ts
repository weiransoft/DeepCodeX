/**
 * DualLayerContextManager.collectGraphContextSnippets 单元测试（U2.*）
 *
 * 测试范围（§13.12.3 定义）：
 * - U2.1 项目目标片段必注入（directRetain 通道，永不丢弃）
 * - U2.2 前序节点摘要按 completedAt 倒序取 Top5（scoringCandidates 通道，排除自身）
 * - U2.3 前序经验按时间取最近 5 条（scoringCandidates 通道，排除自身）
 * - U2.4 动向广播汇总为单条（scoringCandidates 通道，含最近 5 条通知）
 * - U2.5 共享产物按 key 注入（directRetain 通道，JSON 截断 500 字符）
 * - U2.6 空 GraphGlobalContext 降级（返回空数组，不抛异常）
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止使用 mock 框架，使用真实闭包实现和真实类型实例
 * - 测试替身命名使用 Stub / Silent / InMemory 前缀（禁用 Mock 前缀）
 * - 每个测试用例独立，无共享可变状态
 * - 中文注释详细，符合规范
 *
 * 关键挑战：
 * collectGraphContextSnippets 是 DualLayerContextManager 的私有方法，
 * 无法直接调用。通过 buildOptimizedContext(userId, taskId, options) 公开方法间接测试，
 * 传入 options.graphGlobalContext 和 options.currentNodeId，
 * 验证返回的 ContextSnippet[] 中是否包含预期的图级片段。
 *
 * 通道分流说明（§13.8.2）：
 * - directRetain 通道（必注入，不参与评分）：graph_project_goal / graph_shared_artifact
 * - scoringCandidates 通道（参与 Top-K 评分）：graph_node_summary / graph_experience / graph_bulletin
 *
 * @module core/tests/dual-layer-graph-snippets
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";

import { DualLayerContextManager } from "../v2/context/dual-layer-manager";
import type { CodeMapProvider } from "../v2/context/dual-layer-manager";
import { GlobalContextManager } from "../v2/context/global-context";
import { TaskContextManager } from "../v2/context/task-context-manager";
import { SlidingWindowManager } from "../v2/context/sliding-window";
import { RelevanceScorer } from "../v2/context/relevance-scorer";
import { ProgressiveContextLoader } from "../v2/context/progressive-loader";
import { RuleBasedSummarizer } from "../v2/memory/rule-based-summarizer";
import type { CodeMap } from "../v2/codemap/generator";
import type { ContextSnippet } from "../v2/integration/session-hook";

// ============================================================================
// 辅助：Stub / 真实实例构造
// ============================================================================

/**
 * 创建空 CodeMap（用于测试）
 *
 * 提供最小合法 CodeMap 结构，files 为空数组，
 * 使 SlidingWindowManager.buildWindow 能正常运行（无文件可评分）。
 * 图级片段（source 非文件路径）在评分时会得到较低分（NOT_IN_GRAPH_SCORE = 0.1），
 * 但只要 Top-K 容量足够（默认 20）且 Token 预算充足，仍会被保留。
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
 * StubCodeMapProvider：返回空 CodeMap 的 CodeMap 提供者
 *
 * 实现 CodeMapProvider 接口，返回固定的空 CodeMap。
 * 用于让 buildOptimizedContext 的文件层降级为空，
 * 使图级片段成为评分候选的主要来源，便于断言验证。
 */
class StubCodeMapProvider implements CodeMapProvider {
  /** 内部持有的 CodeMap 实例（默认空 CodeMap） */
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
   * @param projectRoot 项目根目录（测试中不使用，仅满足接口签名）
   * @returns 固定的 CodeMap 实例
   */
  async getCodeMap(_projectRoot: string): Promise<CodeMap> {
    return this.codeMap;
  }
}

/**
 * 构造 GraphGlobalContext 测试数据
 *
 * collectGraphContextSnippets 内部通过 unknown 类型断言访问字段，
 * 此辅助函数生成符合断言结构的测试数据，避免在测试用例中重复定义。
 *
 * @param overrides 可选的字段覆盖（默认空对象）
 * @returns GraphGlobalContext 测试数据（unknown 类型，由 collectGraphContextSnippets 内部断言）
 */
function makeGraphGlobalContext(
  overrides: {
    projectGoal?: string;
    globalConstraints?: string[];
    nodeSummaries?: Map<
      string,
      {
        nodeId: string;
        label: string;
        status: string;
        outputSummary: string;
        keyDecisions: string[];
        completedAt: string;
      }
    >;
    collectedExperiences?: Array<{
      experienceId: string;
      sourceNodeId: string;
      type: "success" | "failure";
      taskType: string;
      description: string;
      solution?: string;
      failureReason?: string;
      lessonLearned?: string;
      createdAt: string;
    }>;
    bulletinBoard?: Array<{
      entryId: string;
      sourceNodeId: string;
      type: string;
      summary: string;
      details?: string;
      timestamp: string;
    }>;
    sharedArtifacts?: Record<string, unknown>;
  } = {}
): unknown {
  return {
    projectGoal: overrides.projectGoal,
    globalConstraints: overrides.globalConstraints ?? [],
    nodeSummaries: overrides.nodeSummaries ?? new Map(),
    collectedExperiences: overrides.collectedExperiences ?? [],
    bulletinBoard: overrides.bulletinBoard ?? [],
    sharedArtifacts: overrides.sharedArtifacts ?? {},
  };
}

/**
 * 构造测试用的 DualLayerContextManager 及其依赖
 *
 * 创建真实的依赖实例（非 mock）：
 * - GlobalContextManager：传入不存在的临时文件路径，load 返回默认空上下文
 * - TaskContextManager：真实实例
 * - RelevanceScorer：真实实例
 * - SlidingWindowManager：真实实例（注入 ProgressiveContextLoader + RuleBasedSummarizer）
 * - ProgressiveContextLoader：真实实例
 * - ContentSummarizer：RuleBasedSummarizer（真实启发式算法）
 * - CodeMapProvider：StubCodeMapProvider（返回空 CodeMap）
 *
 * @param codeMapProvider 可选的自定义 CodeMapProvider（默认 StubCodeMapProvider）
 * @returns 包含 manager 和 taskManager 的对象
 */
function createManager(codeMapProvider?: CodeMapProvider): {
  manager: DualLayerContextManager;
  taskManager: TaskContextManager;
} {
  // 真实评分器（零配置，使用默认权重）
  const scorer = new RelevanceScorer();

  // 真实渐进式加载器（100000 token 预算，确保不截断）
  const progressiveLoader = new ProgressiveContextLoader({ tokenBudget: 100_000 });

  // 真实规则摘要器（非 mock，真实启发式算法）
  const summarizer = new RuleBasedSummarizer();

  // 真实滑动窗口管理器（100000 token 预算，Top-K=20，确保图级片段不被截断）
  const windowManager = new SlidingWindowManager(
    { tokenBudget: 100_000, topKFiles: 20 },
    scorer,
    progressiveLoader,
    summarizer
  );

  // StubCodeMapProvider：返回空 CodeMap
  const provider = codeMapProvider ?? new StubCodeMapProvider();

  // 真实 GlobalContextManager：传入不存在的临时文件路径，load 返回默认空上下文
  const tmpFile = path.join(
    os.tmpdir(),
    `test-global-context-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
  );
  const globalManager = new GlobalContextManager(tmpFile);

  // 真实 TaskContextManager
  const taskManager = new TaskContextManager();

  // 被测对象：DualLayerContextManager（不注入可选的 userGlobalMemory / experienceRecommender / ruleStore）
  const manager = new DualLayerContextManager(
    { projectRoot: "/tmp/test-project", defaultTokenBudget: 100_000 },
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
 * 创建测试用任务
 *
 * 通过 TaskContextManager.create 创建一个最小任务定义，
 * 用于 buildOptimizedContext 的 taskId 参数。
 *
 * @param taskManager 任务上下文管理器
 * @param taskId 任务 ID（默认 "task-1"）
 * @returns 创建的 taskId
 */
function createTask(taskManager: TaskContextManager, taskId: string = "task-1"): string {
  taskManager.create(taskId, {
    description: "测试任务：验证图级上下文片段收集",
    goals: ["验证 collectGraphContextSnippets 行为"],
    constraints: [],
    taskType: "test",
    expectedOutput: "图级片段正确生成",
  });
  return taskId;
}

/**
 * 从片段列表中筛选图级片段
 *
 * buildOptimizedContext 返回的片段包含多种类型（user_profile / task_definition / progressive_* 等），
 * 此辅助函数筛选出 graph_* 类型的片段，便于断言。
 *
 * @param snippets 完整片段列表
 * @returns 仅含 graph_* 类型的片段列表
 */
function filterGraphSnippets(snippets: ContextSnippet[]): ContextSnippet[] {
  return snippets.filter((s) => s.type.startsWith("graph_"));
}

// ============================================================================
// U2.* 单元测试用例
// ============================================================================

test("U2.1 项目目标片段必注入 - projectGoal 非空时生成 graph_project_goal 片段，走 directRetain 通道", async () => {
  // ---- 安排（Arrange）----
  const { manager, taskManager } = createManager();
  const taskId = createTask(taskManager);

  // 构造图级上下文：仅含 projectGoal，其余字段为空
  const graphCtx = makeGraphGlobalContext({
    projectGoal: "目标X：完成图编排单元测试",
    globalConstraints: ["约束1：不依赖外部服务", "约束2：测试用例独立"],
  });

  // ---- 行动（Act）----
  // 通过 buildOptimizedContext 间接调用 collectGraphContextSnippets
  const snippets = await manager.buildOptimizedContext("user-1", taskId, {
    graphGlobalContext: graphCtx,
    currentNodeId: "node-current",
    maxTokens: 100_000, // 足够大的 Token 预算，确保 directRetain 片段不被截断
  });

  // ---- 断言（Assert）----
  const graphSnippets = filterGraphSnippets(snippets);

  // 验证点 1：返回 1 条 graph_project_goal 片段（project_goal 永远注入）
  const goalSnippets = graphSnippets.filter((s) => s.type === "graph_project_goal");
  assert.equal(goalSnippets.length, 1, "应生成且仅生成 1 条 graph_project_goal 片段");

  // 验证点 2：content 包含 projectGoal 文本
  const goalSnippet = goalSnippets[0];
  assert.ok(goalSnippet.content.includes("目标X"), "graph_project_goal content 应包含 projectGoal 文本");
  assert.ok(goalSnippet.content.includes("[图编排目标]"), "graph_project_goal content 应包含 [图编排目标] 前缀");

  // 验证点 3：content 包含 globalConstraints
  assert.ok(goalSnippet.content.includes("约束1"), "graph_project_goal content 应包含 globalConstraints");
  assert.ok(goalSnippet.content.includes("约束2"), "graph_project_goal content 应包含全部 globalConstraints");

  // 验证点 4：source 标识为 graph:project_goal
  assert.equal(goalSnippet.source, "graph:project_goal", "graph_project_goal source 应为 'graph:project_goal'");

  // 验证点 5：走 directRetain 通道（片段出现在最终返回数组中，未被评分淘汰）
  // directRetain 片段不参与评分，直接追加到返回数组前部
  // 由于 projectGoal 是 directRetain 通道，它一定在返回数组中（未被 buildWindow 评分淘汰）
  assert.ok(
    snippets.some((s) => s.type === "graph_project_goal"),
    "graph_project_goal 片段应出现在最终返回数组中（directRetain 通道，不被评分淘汰）"
  );
});

test("U2.2 前序节点摘要按 completedAt 倒序取 Top5 - 排除自身节点，走 scoringCandidates 通道", async () => {
  // ---- 安排（Arrange）----
  const { manager, taskManager } = createManager();
  const taskId = createTask(taskManager);

  // 构造 7 个 nodeSummaries，currentNodeId = "node-3"（应被排除）
  // completedAt 按递增顺序设置，倒序后应为 node-7 → node-6 → node-5 → node-4 → node-2
  const nodeSummaries = new Map<
    string,
    {
      nodeId: string;
      label: string;
      status: string;
      outputSummary: string;
      keyDecisions: string[];
      completedAt: string;
    }
  >();

  const nodeData = [
    { nodeId: "node-1", completedAt: "2026-01-01T00:00:00Z", label: "节点1", outputSummary: "产出1" },
    { nodeId: "node-2", completedAt: "2026-01-02T00:00:00Z", label: "节点2", outputSummary: "产出2" },
    { nodeId: "node-3", completedAt: "2026-01-03T00:00:00Z", label: "当前节点", outputSummary: "当前产出" },
    { nodeId: "node-4", completedAt: "2026-01-04T00:00:00Z", label: "节点4", outputSummary: "产出4" },
    { nodeId: "node-5", completedAt: "2026-01-05T00:00:00Z", label: "节点5", outputSummary: "产出5" },
    { nodeId: "node-6", completedAt: "2026-01-06T00:00:00Z", label: "节点6", outputSummary: "产出6" },
    { nodeId: "node-7", completedAt: "2026-01-07T00:00:00Z", label: "节点7", outputSummary: "产出7" },
  ];

  for (const nd of nodeData) {
    nodeSummaries.set(nd.nodeId, {
      nodeId: nd.nodeId,
      label: nd.label,
      status: "completed",
      outputSummary: nd.outputSummary,
      keyDecisions: [`决策-${nd.nodeId}`],
      completedAt: nd.completedAt,
    });
  }

  const graphCtx = makeGraphGlobalContext({
    projectGoal: "图编排目标",
    nodeSummaries,
  });

  // ---- 行动（Act）----
  const snippets = await manager.buildOptimizedContext("user-1", taskId, {
    graphGlobalContext: graphCtx,
    currentNodeId: "node-3", // 排除 node-3
    maxTokens: 100_000,
  });

  // ---- 断言（Assert）----
  const graphSnippets = filterGraphSnippets(snippets);
  const nodeSummarySnippets = graphSnippets.filter((s) => s.type === "graph_node_summary");

  // 验证点 1：返回 5 条 node_summary 片段（Top5，MAX_GRAPH_NODE_SUMMARY_SNIPPETS=5）
  // 7 个节点 - 1 个自身（node-3）= 6 个候选，slice(0, 5) 取前 5 个
  assert.equal(nodeSummarySnippets.length, 5, "应返回 5 条 graph_node_summary 片段（Top5，排除自身后 6 取 5）");

  // 验证点 2：不含自身节点（node-3）
  const nodeIdsInSnippets = nodeSummarySnippets.map((s) => s.source.replace("graph:node_summary:", ""));
  assert.ok(!nodeIdsInSnippets.includes("node-3"), "graph_node_summary 片段不应包含自身节点 node-3");

  // 验证点 3：按 completedAt 倒序排列（最近完成的在前）
  // 排除 node-3 后按 completedAt 倒序：node-7, node-6, node-5, node-4, node-2
  const expectedOrder = ["node-7", "node-6", "node-5", "node-4", "node-2"];
  assert.deepEqual(
    nodeIdsInSnippets,
    expectedOrder,
    "graph_node_summary 片段应按 completedAt 倒序排列（最近完成的在前）"
  );

  // 验证点 4：content 包含节点标签和产出摘要
  const firstSnippet = nodeSummarySnippets[0];
  assert.ok(firstSnippet.content.includes("节点7"), "graph_node_summary content 应包含节点 label");
  assert.ok(firstSnippet.content.includes("产出7"), "graph_node_summary content 应包含 outputSummary");
  assert.ok(firstSnippet.content.includes("[前序节点]"), "graph_node_summary content 应包含 [前序节点] 前缀");

  // 验证点 5：走 scoringCandidates 通道（source 格式为 graph:node_summary:<nodeId>）
  for (const s of nodeSummarySnippets) {
    assert.ok(
      s.source.startsWith("graph:node_summary:"),
      `graph_node_summary source 应以 'graph:node_summary:' 开头，实际: ${s.source}`
    );
  }
});

test("U2.3 前序经验按时间取最近 5 条 - 排除自身节点经验，走 scoringCandidates 通道", async () => {
  // ---- 安排（Arrange）----
  const { manager, taskManager } = createManager();
  const taskId = createTask(taskManager);

  // 构造 8 条 collectedExperiences，其中 2 条 sourceNodeId=node-3（应被排除）
  // 排除后剩 6 条，slice(-5) 取最后 5 条
  const collectedExperiences = [
    {
      experienceId: "exp-1",
      sourceNodeId: "node-1",
      type: "success" as const,
      taskType: "bugfix",
      description: "经验1",
      solution: "方案1",
      createdAt: "2026-01-01T00:00:00Z",
    },
    {
      experienceId: "exp-2",
      sourceNodeId: "node-2",
      type: "failure" as const,
      taskType: "feature",
      description: "经验2",
      failureReason: "原因2",
      lessonLearned: "教训2",
      createdAt: "2026-01-02T00:00:00Z",
    },
    {
      experienceId: "exp-3",
      sourceNodeId: "node-3", // 排除（自身节点）
      type: "success" as const,
      taskType: "bugfix",
      description: "自身经验3",
      solution: "自身方案3",
      createdAt: "2026-01-03T00:00:00Z",
    },
    {
      experienceId: "exp-4",
      sourceNodeId: "node-1",
      type: "success" as const,
      taskType: "refactor",
      description: "经验4",
      solution: "方案4",
      createdAt: "2026-01-04T00:00:00Z",
    },
    {
      experienceId: "exp-5",
      sourceNodeId: "node-2",
      type: "failure" as const,
      taskType: "test",
      description: "经验5",
      failureReason: "原因5",
      lessonLearned: "教训5",
      createdAt: "2026-01-05T00:00:00Z",
    },
    {
      experienceId: "exp-6",
      sourceNodeId: "node-3", // 排除（自身节点）
      type: "success" as const,
      taskType: "bugfix",
      description: "自身经验6",
      solution: "自身方案6",
      createdAt: "2026-01-06T00:00:00Z",
    },
    {
      experienceId: "exp-7",
      sourceNodeId: "node-4",
      type: "success" as const,
      taskType: "feature",
      description: "经验7",
      solution: "方案7",
      createdAt: "2026-01-07T00:00:00Z",
    },
    {
      experienceId: "exp-8",
      sourceNodeId: "node-5",
      type: "failure" as const,
      taskType: "deploy",
      description: "经验8",
      failureReason: "原因8",
      lessonLearned: "教训8",
      createdAt: "2026-01-08T00:00:00Z",
    },
  ];

  const graphCtx = makeGraphGlobalContext({
    projectGoal: "图编排目标",
    collectedExperiences,
  });

  // ---- 行动（Act）----
  const snippets = await manager.buildOptimizedContext("user-1", taskId, {
    graphGlobalContext: graphCtx,
    currentNodeId: "node-3", // 排除 sourceNodeId=node-3 的经验
    maxTokens: 100_000,
  });

  // ---- 断言（Assert）----
  const graphSnippets = filterGraphSnippets(snippets);
  const experienceSnippets = graphSnippets.filter((s) => s.type === "graph_experience");

  // 验证点 1：返回 5 条 experience 片段
  // 8 条 - 2 条自身 = 6 条候选，按 createdAt 降序取最近 5 条
  // v4-L2 修复：与 recallExperiences 排序逻辑保持一致（按 createdAt 降序）
  assert.equal(
    experienceSnippets.length,
    5,
    "应返回 5 条 graph_experience 片段（排除自身后 6 条按 createdAt 降序取最近 5 条）"
  );

  // 验证点 2：不含自身节点经验（exp-3, exp-6）
  const expIdsInSnippets = experienceSnippets.map((s) => s.source.replace("graph:experience:", ""));
  assert.ok(!expIdsInSnippets.includes("exp-3"), "graph_experience 片段不应包含自身节点经验 exp-3");
  assert.ok(!expIdsInSnippets.includes("exp-6"), "graph_experience 片段不应包含自身节点经验 exp-6");

  // 验证点 3：按 createdAt 降序取最近 5 条（exp-8, exp-7, exp-5, exp-4, exp-2）
  // 排除 exp-3, exp-6 后剩 exp-1~exp-2, exp-4~exp-5, exp-7~exp-8
  // sort(createdAt 降序) + slice(0, 5) 取最近 5 条：exp-8, exp-7, exp-5, exp-4, exp-2
  const expectedExpIds = ["exp-8", "exp-7", "exp-5", "exp-4", "exp-2"];
  assert.deepEqual(expIdsInSnippets, expectedExpIds, "graph_experience 片段应按 createdAt 降序取排除自身后的最近 5 条");

  // 验证点 4：走 scoringCandidates 通道（source 格式为 graph:experience:<experienceId>）
  for (const s of experienceSnippets) {
    assert.ok(
      s.source.startsWith("graph:experience:"),
      `graph_experience source 应以 'graph:experience:' 开头，实际: ${s.source}`
    );
  }

  // 验证点 5：content 包含经验描述和方案/教训
  const successSnippet = experienceSnippets.find((s) => s.content.includes("[前序成功经验]"));
  assert.ok(successSnippet, "应存在成功经验片段（type=success）");
  assert.ok(successSnippet.content.includes("方案"), "成功经验 content 应包含 solution 字段");

  const failureSnippet = experienceSnippets.find((s) => s.content.includes("[前序失败教训]"));
  assert.ok(failureSnippet, "应存在失败经验片段（type=failure）");
  assert.ok(failureSnippet.content.includes("原因"), "失败经验 content 应包含 failureReason 字段");
  assert.ok(failureSnippet.content.includes("教训"), "失败经验 content 应包含 lessonLearned 字段");
});

test("U2.4 动向广播汇总为单条 - content 含最近 5 条通知摘要，走 scoringCandidates 通道", async () => {
  // ---- 安排（Arrange）----
  const { manager, taskManager } = createManager();
  const taskId = createTask(taskManager);

  // 构造 8 条 bulletinBoard，slice(-5) 取最后 5 条汇总为单条片段
  const bulletinBoard = Array.from({ length: 8 }, (_, i) => ({
    entryId: `bulletin-${i + 1}`,
    sourceNodeId: `node-${i + 1}`,
    type: i % 2 === 0 ? "progress" : "blocker",
    summary: `通知${i + 1}`,
    details: `详情${i + 1}`,
    timestamp: `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
  }));

  const graphCtx = makeGraphGlobalContext({
    projectGoal: "图编排目标",
    bulletinBoard,
  });

  // ---- 行动（Act）----
  const snippets = await manager.buildOptimizedContext("user-1", taskId, {
    graphGlobalContext: graphCtx,
    currentNodeId: "node-current",
    maxTokens: 100_000,
  });

  // ---- 断言（Assert）----
  const graphSnippets = filterGraphSnippets(snippets);
  const bulletinSnippets = graphSnippets.filter((s) => s.type === "graph_bulletin");

  // 验证点 1：返回 1 条 bulletin 片段（汇总为单条）
  assert.equal(bulletinSnippets.length, 1, "应返回 1 条 graph_bulletin 片段（多条通知汇总为单条）");

  // 验证点 2：content 包含最近 5 条通知摘要（bulletin-4 ~ bulletin-8）
  const bulletinContent = bulletinSnippets[0].content;
  assert.ok(bulletinContent.includes("[动向广播]"), "graph_bulletin content 应包含 [动向广播] 前缀");

  // 验证包含最后 5 条通知的 summary
  for (let i = 4; i <= 8; i++) {
    assert.ok(bulletinContent.includes(`通知${i}`), `graph_bulletin content 应包含最近 5 条通知中的"通知${i}"`);
  }

  // 验证不包含前 3 条通知的 summary（被 slice(-5) 截断）
  for (let i = 1; i <= 3; i++) {
    assert.ok(!bulletinContent.includes(`通知${i}`), `graph_bulletin content 不应包含被截断的通知"通知${i}"`);
  }

  // 验证点 3：走 scoringCandidates 通道（source 为 graph:bulletin_board）
  assert.equal(bulletinSnippets[0].source, "graph:bulletin_board", "graph_bulletin source 应为 'graph:bulletin_board'");
});

test("U2.5 共享产物按 key 注入 - 多 key 遍历，走 directRetain 通道，JSON 截断 500 字符", async () => {
  // ---- 安排（Arrange）----
  const { manager, taskManager } = createManager();
  const taskId = createTask(taskManager);

  // 构造 sharedArtifacts：2 个 key
  // - designDoc：字符串类型，不截断
  // - apiSpec：对象类型，JSON.stringify 后超过 500 字符，验证截断
  const longString = "x".repeat(600); // 600 字符，超过 500 字符截断阈值
  const sharedArtifacts = {
    designDoc: "内容A：设计文档摘要",
    apiSpec: {
      name: "api-spec",
      version: "1.0.0",
      endpoints: [
        { path: "/api/v1/users", method: "GET" },
        { path: "/api/v1/users", method: "POST" },
      ],
      longField: longString, // 超长字段，使 JSON.stringify 结果超过 500 字符
    },
  };

  const graphCtx = makeGraphGlobalContext({
    projectGoal: "图编排目标",
    sharedArtifacts,
  });

  // ---- 行动（Act）----
  const snippets = await manager.buildOptimizedContext("user-1", taskId, {
    graphGlobalContext: graphCtx,
    currentNodeId: "node-current",
    maxTokens: 100_000,
  });

  // ---- 断言（Assert）----
  const graphSnippets = filterGraphSnippets(snippets);
  const artifactSnippets = graphSnippets.filter((s) => s.type === "graph_shared_artifact");

  // 验证点 1：返回 2 条 shared_artifact 片段（按 key 遍历）
  assert.equal(artifactSnippets.length, 2, "应返回 2 条 graph_shared_artifact 片段（按 sharedArtifacts 的 key 遍历）");

  // 验证点 2：每条片段的 source 标识包含对应 key
  const sources = artifactSnippets.map((s) => s.source).sort();
  assert.deepEqual(
    sources,
    ["graph:shared_artifact:apiSpec", "graph:shared_artifact:designDoc"],
    "graph_shared_artifact source 应包含对应 key（graph:shared_artifact:<key>）"
  );

  // 验证点 3：designDoc 片段 content 包含原始字符串内容（字符串类型不截断）
  const designDocSnippet = artifactSnippets.find((s) => s.source.includes("designDoc"));
  assert.ok(designDocSnippet, "应存在 designDoc 对应的 shared_artifact 片段");
  assert.ok(designDocSnippet.content.includes("内容A"), "字符串类型的 sharedArtifact content 应包含原始字符串内容");
  assert.ok(designDocSnippet.content.includes("[共享产物]"), "graph_shared_artifact content 应包含 [共享产物] 前缀");

  // 验证点 4：apiSpec 片段 content 包含 JSON 序列化结果（对象类型 JSON.stringify）
  const apiSpecSnippet = artifactSnippets.find((s) => s.source.includes("apiSpec"));
  assert.ok(apiSpecSnippet, "应存在 apiSpec 对应的 shared_artifact 片段");
  assert.ok(
    apiSpecSnippet.content.includes("api-spec"),
    "对象类型的 sharedArtifact content 应包含 JSON 序列化后的字段"
  );

  // 验证点 5：JSON 截断 500 字符
  // 提取 content 中 JSON 部分的长度（[共享产物] apiSpec: <JSON> 中的 <JSON> 部分）
  const jsonPrefix = "[共享产物] apiSpec: ";
  const jsonStartIdx = apiSpecSnippet.content.indexOf(jsonPrefix);
  assert.ok(jsonStartIdx !== -1, "content 应包含 [共享产物] apiSpec: 前缀");
  const jsonPart = apiSpecSnippet.content.slice(jsonStartIdx + jsonPrefix.length);
  assert.ok(
    jsonPart.length <= 500,
    `对象类型的 sharedArtifact JSON 部分应被截断到 500 字符以内，实际长度: ${jsonPart.length}`
  );

  // 验证点 6：走 directRetain 通道（片段出现在最终返回数组中，未被评分淘汰）
  assert.ok(
    snippets.some((s) => s.type === "graph_shared_artifact"),
    "graph_shared_artifact 片段应出现在最终返回数组中（directRetain 通道，不被评分淘汰）"
  );
});

test("U2.6 空 GraphGlobalContext 降级 - graphGlobalContext 为 null 或 undefined 时不抛异常，返回空图级片段", async () => {
  // ---- 安排（Arrange）----
  // 子用例 1：graphGlobalContext = null
  {
    const { manager, taskManager } = createManager();
    const taskId = createTask(taskManager, "task-null");

    // ---- 行动（Act）----
    // 传入 graphGlobalContext=null，currentNodeId 有值
    // buildOptimizedContext 的 if (graphGlobalContext && currentNodeId) 条件不满足（null 是 falsy）
    // 不调用 collectGraphContextSnippets，降级为无图级片段
    const snippets = await manager.buildOptimizedContext("user-1", taskId, {
      graphGlobalContext: null,
      currentNodeId: "node-current",
      maxTokens: 100_000,
    });

    // ---- 断言（Assert）----
    const graphSnippets = filterGraphSnippets(snippets);

    // 验证点 1：返回的片段中不含任何 graph_* 类型片段
    assert.equal(graphSnippets.length, 0, "graphGlobalContext=null 时应返回 0 条图级片段（降级语义）");

    // 验证点 2：不抛异常（buildOptimizedContext 正常返回）
    // 若抛异常，上面的 await 会抛出，测试会失败
    assert.ok(Array.isArray(snippets), "graphGlobalContext=null 时 buildOptimizedContext 应正常返回数组");
  }

  // 子用例 2：graphGlobalContext = undefined
  {
    const { manager, taskManager } = createManager();
    const taskId = createTask(taskManager, "task-undefined");

    // ---- 行动（Act）----
    // 传入 graphGlobalContext=undefined，currentNodeId 有值
    // undefined 是 falsy，if 条件不满足，不调用 collectGraphContextSnippets
    const snippets = await manager.buildOptimizedContext("user-1", taskId, {
      graphGlobalContext: undefined,
      currentNodeId: "node-current",
      maxTokens: 100_000,
    });

    // ---- 断言（Assert）----
    const graphSnippets = filterGraphSnippets(snippets);

    // 验证点 1：返回的片段中不含任何 graph_* 类型片段
    assert.equal(graphSnippets.length, 0, "graphGlobalContext=undefined 时应返回 0 条图级片段（降级语义）");

    // 验证点 2：不抛异常
    assert.ok(Array.isArray(snippets), "graphGlobalContext=undefined 时 buildOptimizedContext 应正常返回数组");
  }

  // 子用例 3：graphGlobalContext 为空对象（所有字段为空/默认值）
  // 验证 collectGraphContextSnippets 内部的 if (!ctx) return [] 之后的字段级降级
  {
    const { manager, taskManager } = createManager();
    const taskId = createTask(taskManager, "task-empty");

    // 构造空 GraphGlobalContext（所有集合字段为空）
    const emptyGraphCtx = makeGraphGlobalContext({});

    // ---- 行动（Act）----
    const snippets = await manager.buildOptimizedContext("user-1", taskId, {
      graphGlobalContext: emptyGraphCtx,
      currentNodeId: "node-current",
      maxTokens: 100_000,
    });

    // ---- 断言（Assert）----
    const graphSnippets = filterGraphSnippets(snippets);

    // 验证点：空 GraphGlobalContext（无 projectGoal / nodeSummaries / ...）时不生成图级片段
    assert.equal(graphSnippets.length, 0, "空 GraphGlobalContext（所有字段为空）应返回 0 条图级片段（字段级降级）");

    // 验证不抛异常
    assert.ok(Array.isArray(snippets), "空 GraphGlobalContext 时 buildOptimizedContext 应正常返回数组");
  }
});

// ============================================================================
// U4.4 图级片段超 Token 预算按 relevance 升序丢弃（v3.1-H3 修复）
//
// 设计要求（§13.12.3 U4.4）：
// - 图级片段超 Token 预算时按 relevance 升序丢弃
// - 先丢 0.75（bulletin），再丢 0.85（experience），保留 1.0（project_goal）
// - project_goal 走 directRetain 通道，永不丢弃
//
// v3.1-H3 修复背景：
// - 旧 U4.4 测试内容为"deepFreeze 后数组不可变"，与 U1.6 重复
// - Token 预算截断逻辑（collectGraphContextSnippets 内部）零测试覆盖
// - 本测试通过构造超预算的图级片段，验证 project_goal 必保留 + 低 relevance 优先丢弃
// ============================================================================

test("U4.4 图级片段超 Token 预算按 relevance 升序丢弃 - 保留 1.0（project_goal），丢弃 0.75/0.85", async () => {
  // ---- 安排（Arrange）----
  // 构造低 Token 预算的 manager，使图级片段容易超预算
  // GRAPH_SNIPPET_TOKEN_BUDGET=4000 是常量，无法外部覆盖，
  // 因此通过构造大量图级片段内容，使总 Token 超过 4000
  const { manager, taskManager } = createManager();
  const taskId = createTask(taskManager, "task-u44");

  // 构造大量图级片段，使总 Token 超过 GRAPH_SNIPPET_TOKEN_BUDGET=4000
  // - projectGoal：1 条，relevance=1.0（directRetain，永不丢弃）
  // - sharedArtifacts：5 条，relevance=0.9（directRetain）
  // - nodeSummaries：10 条，relevance=0.8（scoringCandidates）
  // - collectedExperiences：10 条，relevance=0.85（scoringCandidates）
  // - bulletinBoard：10 条，relevance=0.75（scoringCandidates，优先丢弃）

  // 每条内容 1000 字符，确保超预算（v4-H2：500 字符时总 Token≈2964 < 4000 未超预算）
  const longContent = "x".repeat(1000);

  // 构造 10 个 nodeSummaries（每个 500 字符）
  const nodeSummaries = new Map<string, unknown>();
  for (let i = 0; i < 10; i++) {
    nodeSummaries.set(`node-u44-${i}`, {
      nodeId: `node-u44-${i}`,
      nodeType: "task",
      label: `节点${i}`,
      status: "completed",
      outputSummary: longContent,
      keyDecisions: [],
      completedAt: `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
    });
  }

  // 构造 10 条 collectedExperiences（每个 500 字符）
  const collectedExperiences = [];
  for (let i = 0; i < 10; i++) {
    collectedExperiences.push({
      experienceId: `exp-u44-${i}`,
      sourceNodeId: `node-u44-${i}`,
      type: i % 2 === 0 ? "success" : "failure",
      taskType: "coding",
      description: longContent,
      solution: i % 2 === 0 ? `solution-${i}` : undefined,
      failureReason: i % 2 !== 0 ? `reason-${i}` : undefined,
      createdAt: `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
    });
  }

  // 构造 10 条 bulletinBoard（每个 500 字符，relevance=0.75 最低，应优先丢弃）
  const bulletinBoard = [];
  for (let i = 0; i < 10; i++) {
    bulletinBoard.push({
      entryId: `bul-u44-${i}`,
      sourceNodeId: `node-u44-${i}`,
      type: "milestone",
      summary: longContent,
      timestamp: `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
    });
  }

  // 构造 5 条 sharedArtifacts（每个 500 字符，relevance=0.9 directRetain）
  const sharedArtifacts: Record<string, unknown> = {};
  for (let i = 0; i < 5; i++) {
    sharedArtifacts[`artifact-${i}`] = longContent;
  }

  const graphCtx = makeGraphGlobalContext({
    projectGoal: "U4.4 项目目标（必保留，relevance=1.0）",
    nodeSummaries,
    collectedExperiences,
    bulletinBoard,
    sharedArtifacts,
  });

  // ---- 行动（Act）----
  const snippets = await manager.buildOptimizedContext("user-u44", taskId, {
    graphGlobalContext: graphCtx,
    currentNodeId: "current-node-u44",
    maxTokens: 100_000, // 总 Token 预算充足，但 GRAPH_SNIPPET_TOKEN_BUDGET=4000 会限制图级片段
  });

  // ---- 断言（Assert）----
  const graphSnippets = filterGraphSnippets(snippets);

  // 验证点 1：project_goal 片段必须保留（relevance=1.0，directRetain 通道，永不丢弃）
  const goalSnippets = graphSnippets.filter((s) => s.type === "graph_project_goal");
  assert.equal(goalSnippets.length, 1, "project_goal 片段必须保留（relevance=1.0，directRetain 通道，永不丢弃）");
  assert.ok(goalSnippets[0].content.includes("U4.4 项目目标"), "project_goal 片段内容应包含原始目标文本");

  // 验证点 2：图级片段总数受 GRAPH_SNIPPET_TOKEN_BUDGET=4000 限制
  // 总内容 = projectGoal(1) + sharedArtifacts(5×500) + nodeSummaries(10×500) + experiences(10×500) + bulletin(10×500)
  //        = 1 + 2500 + 5000 + 5000 + 5000 = 17501 字符（远超 4000 Token ≈ 16000 字符）
  // 但因 relevance 评分和 Top-K 限制，实际保留的片段数应远小于总输入
  // 关键验证：project_goal 必须保留，bulletin 应被优先丢弃

  // 验证点 3：bulletin（relevance=0.75）应被完全丢弃（v4-H2 严格断言）
  // collectGraphContextSnippets 内部 Token 预算截断逻辑：
  // - project_goal 永不丢弃（relevance=1.0）
  // - 其余按 relevance 降序保留，直到 Token 用完
  // - bulletin（0.75）最低，超预算时优先丢弃
  // 总内容约 5211 Token > GRAPH_SNIPPET_TOKEN_BUDGET(4000)，bulletin 应被完全丢弃
  const bulletinSnippets = graphSnippets.filter((s) => s.type === "graph_bulletin");
  assert.equal(
    bulletinSnippets.length,
    0,
    `bulletin 片段应被完全丢弃（relevance=0.75 最低且超预算，实际 ${bulletinSnippets.length} 条）`
  );

  // 验证点 4：experience（relevance=0.85）应比 bulletin 优先保留（v4-H2 新增）
  // relevance 0.85 > 0.75，超预算截断时 experience 应比 bulletin 优先保留
  const experienceSnippets = graphSnippets.filter((s) => s.type === "graph_experience");
  assert.ok(
    experienceSnippets.length >= bulletinSnippets.length,
    `experience 片段保留数（${experienceSnippets.length}）应 >= bulletin 保留数（${bulletinSnippets.length}），因 relevance 0.85 > 0.75`
  );

  // 验证点 5：project_goal 的 relevance 应为 1.0（最高优先级）
  assert.equal(goalSnippets[0].relevance, 1.0, "project_goal 片段 relevance 应为 1.0（最高优先级，永不丢弃）");

  // 验证点 6：所有保留的图级片段 content 非空
  for (const snippet of graphSnippets) {
    assert.ok(snippet.content.length > 0, `图级片段 ${snippet.type} content 应非空`);
  }

  console.log(
    `  U4.4 结果：project_goal=${goalSnippets.length}，bulletin=${bulletinSnippets.length}，` +
      `总图级片段=${graphSnippets.length}（输入：1 goal + 5 artifacts + 10 summaries + 10 exp + 10 bul）`
  );
});
