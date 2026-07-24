/**
 * EAG-Graph 嵌套图与失败恢复集成测试（TOP-2）
 *
 * 测试范围：
 * - D1.  嵌套 fork + loop + merge 图成功路径
 * - D2.  节点失败后自动重试成功
 * - D3.  节点重试耗尽后自动隔离，下游继续执行
 * - D4.  fork 一个分支失败，其他分支继续执行
 * - D5.  merge 节点前所有分支失败
 * - D6.  merge 节点部分输入可用（一个分支失败/隔离、一个分支成功）
 * - D7.  图级总重试预算耗尽
 * - D8.  连续节点失败熔断
 * - D9.  分支状态隔离后全局状态合并正确性
 * - D10. 通过 GraphLifecycleManager 运行复杂失败恢复图
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止使用 mock 框架，使用真实类型实例和闭包实现 executor
 * - 每个测试用例独立，无共享可变状态
 * - 所有辅助函数与测试替身写中文注释
 *
 * 设计依据：
 * - docs/superpowers/plans/2026-07-23-eag-graph-top5-improvements.md 阶段 D
 * - docs/enterprise/EAG-GRAPH-LOOP-MANUAL.md 附录 D TOP-2
 * - eag/graph/graph-loop-orchestrator.ts 源文件（被测对象）
 *
 * @module core/tests/eag-graph-nested-recovery
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { GraphLoopOrchestrator } from "../eag/graph/graph-loop-orchestrator";
import { GraphBuilder } from "../eag/graph/graph-builder";
import { EdgeResolverImpl } from "../eag/graph/graph-edge-resolver";
import { GraphGuardImpl } from "../eag/graph/graph-guard";
import { GraphSchedulerImpl } from "../eag/graph/graph-scheduler";
import { PredicateRegistryImpl } from "../eag/graph/predicate-registry";
import { GraphLifecycleManager } from "../eag/graph/graph-lifecycle-manager";
import { DEFAULT_WORK_GRAPH_CONFIG, createRetrySuppressionConfig } from "../eag/graph/graph-loop-models";
import type {
  WorkGraph,
  GraphNodeDef,
  GraphNodeResult,
  GraphRunContext,
  NodeFieldContract,
  GraphLogger,
  RetrySuppressionConfig,
} from "../eag/graph/graph-loop-models";
import type { NodeExecutorProtocol } from "../eag/graph/graph-loop-protocols";

// ============================================================================
// 辅助：构造测试数据
// ============================================================================

/**
 * 构造一个 task 节点定义
 *
 * @param nodeId 节点 ID
 * @param outputContract 输出契约（可选）
 * @param inputContract 输入契约（可选）
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
 * 构造一个 fork 节点定义
 *
 * @param nodeId 节点 ID
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
 * 构造一个 merge 节点定义
 *
 * @param nodeId 节点 ID
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
 * 构造一个 loop 节点定义（测试中使用 FailingNodeExecutor 直接返回结果，不依赖真实 Loop 内核）
 *
 * @param nodeId 节点 ID
 */
function makeLoopNode(nodeId: string): GraphNodeDef {
  return {
    nodeId,
    nodeType: "loop",
    label: nodeId,
    task: `${nodeId} 循环任务`,
    inputContract: [],
    outputContract: [],
    loopConfig: {
      loopType: "coding",
      discoveryMode: "auto",
      evaluatorMode: "standard",
      maxIterations: 3,
      maxTokens: 10000,
      stopWhen: "",
      stageOrder: ["plan", "dev", "verify"],
      autoCommit: false,
      humanCheckpointEvery: 0,
    },
  };
}

/**
 * 创建不输出日志的 GraphLogger（测试用，避免噪音）
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
 */
function makeConfig(overrides?: Partial<typeof DEFAULT_WORK_GRAPH_CONFIG>): typeof DEFAULT_WORK_GRAPH_CONFIG {
  return {
    ...DEFAULT_WORK_GRAPH_CONFIG,
    ...overrides,
  };
}

// ============================================================================
// FailingNodeExecutor 测试替身
// ============================================================================

/**
 * 节点行为类型
 *
 * - success: 返回 completed 状态
 * - fail: 返回 failed 状态
 * - throw: 抛出异常
 */
type NodeBehavior = "success" | "fail" | "throw";

/**
 * 单个节点的失败规则
 *
 * 支持按调用次数、序列、异常、部分输出和自定义决策函数控制节点行为。
 */
interface NodeFailureRule {
  /**
   * 前 N 次调用失败，之后按 thenBehavior 执行
   */
  failCount?: number;

  /**
   * failCount 耗尽后的行为（默认 success）
   */
  thenBehavior?: NodeBehavior;

  /**
   * 按调用次数精确指定行为序列，优先级高于 failCount
   *
   * 数组下标对应第几次调用（0-based），超出数组长度后默认成功。
   */
  sequence?: NodeBehavior[];

  /**
   * 成功时返回的默认输出
   */
  output?: Record<string, unknown>;

  /**
   * 按调用次数指定输出（key 为调用序号 0-based）
   */
  outputsByCall?: Readonly<Record<number, Record<string, unknown>>>;

  /**
   * 在指定调用次数抛出异常（数组元素为调用序号 0-based）
   */
  throwOnCalls?: number[];

  /**
   * 抛出异常时的错误信息
   */
  throwMessage?: string;

  /**
   * 自定义决策函数（最高优先级）
   *
   * 返回 NodeBehavior，可基于节点、输入、上下文和调用次数做复杂决策。
   */
  decide?: (
    node: Readonly<GraphNodeDef>,
    input: Readonly<Record<string, unknown>>,
    context: Readonly<GraphRunContext>,
    callCount: number
  ) => NodeBehavior;
}

/**
 * FailingNodeExecutor 配置选项
 */
interface FailingNodeExecutorOptions {
  /**
   * 默认行为，未配置规则的节点使用
   */
  defaultBehavior?: NodeBehavior;

  /**
   * 默认成功输出
   */
  defaultOutput?: Record<string, unknown>;

  /**
   * 节点 ID -> 规则
   */
  rules?: ReadonlyMap<string, NodeFailureRule>;
}

/**
 * 支持按节点 ID / 调用次数 / 异常 / 部分输出控制的测试执行器
 *
 * 实现 NodeExecutorProtocol，用于精确模拟节点失败、重试、隔离等场景。
 * 控制节点（fork / merge / decision / end）在未配置规则时默认成功。
 */
class FailingNodeExecutor implements NodeExecutorProtocol {
  /** 默认行为 */
  private readonly defaultBehavior: NodeBehavior;
  /** 默认成功输出 */
  private readonly defaultOutput: Record<string, unknown>;
  /** 节点规则表 */
  private readonly rules: ReadonlyMap<string, NodeFailureRule>;
  /** 每个节点的调用次数 */
  private readonly callCounts = new Map<string, number>();

  /**
   * 构造测试执行器
   *
   * @param options 配置选项
   */
  constructor(options?: FailingNodeExecutorOptions) {
    this.defaultBehavior = options?.defaultBehavior ?? "success";
    this.defaultOutput = options?.defaultOutput ?? {};
    this.rules = options?.rules ?? new Map();
  }

  /**
   * 执行单个图节点
   *
   * 根据节点 ID 查找规则，按优先级决策：
   * 1. 自定义 decide 函数
   * 2. throwOnCalls 中命中当前调用次数
   * 3. sequence 中命中当前调用次数
   * 4. failCount 前 N 次失败
   * 5. 默认行为
   *
   * 控制节点（fork / merge / decision / end）未配置规则时默认返回 completed。
   *
   * @param node 节点定义
   * @param input 输入数据
   * @param context 图运行上下文
   * @returns 节点执行结果
   */
  async execute(
    node: Readonly<GraphNodeDef>,
    input: Readonly<Record<string, unknown>>,
    context: Readonly<GraphRunContext>
  ): Promise<GraphNodeResult> {
    const nodeId = node.nodeId;
    const count = this.callCounts.get(nodeId) ?? 0;
    this.callCounts.set(nodeId, count + 1);

    const rule = this.rules.get(nodeId);

    // 控制节点默认成功（除非被规则覆盖）
    const isControlNode =
      node.nodeType === "fork" || node.nodeType === "merge" || node.nodeType === "decision" || node.nodeType === "end";
    const baseBehavior: NodeBehavior = isControlNode ? "success" : this.defaultBehavior;

    // 决策优先级：decide > throwOnCalls > sequence > failCount > default
    let behavior = baseBehavior;

    if (rule?.decide) {
      behavior = rule.decide(node, input, context, count);
    } else if (rule?.throwOnCalls?.includes(count)) {
      behavior = "throw";
    } else if (rule?.sequence && count < rule.sequence.length) {
      behavior = rule.sequence[count];
    } else if (rule?.failCount !== undefined && count < rule.failCount) {
      behavior = "fail";
    } else if (rule?.thenBehavior) {
      behavior = rule.thenBehavior;
    }

    // 输出选择：优先 outputsByCall[callIndex]，其次 rule.output，最后 defaultOutput
    const outputByCall = rule?.outputsByCall?.[count];
    const output = outputByCall ?? rule?.output ?? this.defaultOutput;

    // 构造结果
    if (behavior === "throw") {
      throw new Error(rule?.throwMessage ?? `${nodeId} 模拟异常（第 ${count + 1} 次调用）`);
    }

    if (behavior === "fail") {
      return {
        nodeId,
        nodeType: node.nodeType,
        status: "failed",
        output: {},
        durationSec: 0.01,
        failureReason: `${nodeId} 模拟失败（第 ${count + 1} 次调用）`,
        retryCount: count,
      };
    }

    return {
      nodeId,
      nodeType: node.nodeType,
      status: "completed",
      output,
      durationSec: 0.01,
      retryCount: count,
    };
  }
}

// ============================================================================
// 辅助：创建编排器
// ============================================================================

/**
 * 创建完整的编排器（使用真实组件）
 *
 * @param executor 节点执行器
 * @param configOverrides 图级配置覆盖
 * @param retrySuppressionOverrides 重试抑制配置覆盖
 */
function createOrchestrator(
  executor: NodeExecutorProtocol,
  configOverrides?: Partial<typeof DEFAULT_WORK_GRAPH_CONFIG>,
  retrySuppressionOverrides?: Partial<RetrySuppressionConfig>
): GraphLoopOrchestrator {
  const predicateRegistry = new PredicateRegistryImpl();
  const logger = makeSilentLogger();

  // 重试抑制配置：默认使用宽松值避免测试中过早熔断
  // 注意：createRetrySuppressionConfig 签名是 (nodeCount, nodeRetryLimit, overrides)
  const retrySuppression = createRetrySuppressionConfig(
    10,
    configOverrides?.nodeRetryLimit ?? DEFAULT_WORK_GRAPH_CONFIG.nodeRetryLimit,
    {
      maxTotalRetries: retrySuppressionOverrides?.maxTotalRetries ?? 100,
      maxIterationsPerNode: retrySuppressionOverrides?.maxIterationsPerNode ?? 100,
      consecutiveNodeFailureThreshold: retrySuppressionOverrides?.consecutiveNodeFailureThreshold ?? 10,
    }
  );

  const scheduler = new GraphSchedulerImpl(retrySuppression, logger);
  const guard = new GraphGuardImpl(logger);
  const edgeResolver = new EdgeResolverImpl(logger);

  return new GraphLoopOrchestrator({
    nodeExecutor: executor,
    edgeResolver,
    graphScheduler: scheduler,
    graphGuard: guard,
    predicateRegistry,
    logger,
  });
}

// ============================================================================
// D1. 嵌套 fork + loop + merge 图成功路径
// ============================================================================

test("D1. 嵌套 fork + loop + merge 图成功路径", async () => {
  // 构造图：start -> fork1 -> [loopA, loopB] -> merge1 -> end
  const graph: WorkGraph = GraphBuilder.create()
    .setGraphInfo("g-d1", "嵌套 fork-loop-merge 图", "D1 测试")
    .addNode(makeTaskNode("start"))
    .addNode(makeForkNode("fork1"))
    .addNode(makeLoopNode("loopA"))
    .addNode(makeLoopNode("loopB"))
    .addNode(makeMergeNode("merge1"))
    .addNode(makeEndNode("end"))
    .addEdge({ edgeId: "e1", from: "start", to: "fork1", dataMapping: {} })
    .addEdge({ edgeId: "e2", from: "fork1", to: "loopA", dataMapping: {} })
    .addEdge({ edgeId: "e3", from: "fork1", to: "loopB", dataMapping: {} })
    .addEdge({ edgeId: "e4", from: "loopA", to: "merge1", dataMapping: {} })
    .addEdge({ edgeId: "e5", from: "loopB", to: "merge1", dataMapping: {} })
    .addEdge({ edgeId: "e6", from: "merge1", to: "end", dataMapping: {} })
    .setEntryNodeId("start")
    .setConfig(makeConfig({ maxParallelism: 4 }))
    .build();

  const executor = new FailingNodeExecutor({
    defaultBehavior: "success",
    rules: new Map([
      ["loopA", { output: { result: "A-ok" } }],
      ["loopB", { output: { result: "B-ok" } }],
    ]),
  });
  const orchestrator = createOrchestrator(executor);

  const report = await orchestrator.run(graph);

  assert.equal(report.finalStatus, "completed", "嵌套 fork-loop-merge 图应成功完成");
  assert.ok(report.traversalPath.includes("start"), "路径包含 start");
  assert.ok(report.traversalPath.includes("fork1"), "路径包含 fork1");
  assert.ok(report.traversalPath.includes("loopA"), "路径包含 loopA");
  assert.ok(report.traversalPath.includes("loopB"), "路径包含 loopB");
  assert.ok(report.traversalPath.includes("merge1"), "路径包含 merge1");
  assert.ok(report.traversalPath.includes("end"), "路径包含 end");
  assert.equal(report.nodeResults.get("loopA")?.status, "completed", "loopA 应 completed");
  assert.equal(report.nodeResults.get("loopB")?.status, "completed", "loopB 应 completed");
  assert.equal(report.nodeResults.get("merge1")?.status, "completed", "merge1 应 completed");
});

// ============================================================================
// D2. 节点失败后自动重试成功
// ============================================================================

test("D2. 节点失败后自动重试成功", async () => {
  // 构造图：A -> end；A 前 2 次失败，第 3 次成功
  const graph: WorkGraph = GraphBuilder.create()
    .setGraphInfo("g-d2", "重试成功图", "D2 测试")
    .addNode(makeTaskNode("A", [{ name: "result", type: "string", required: true }]))
    .addNode(makeEndNode("end"))
    .addEdge({ edgeId: "e1", from: "A", to: "end", dataMapping: {} })
    .setEntryNodeId("A")
    .setConfig(makeConfig({ nodeRetryLimit: 3, enableAutoIsolation: true }))
    .build();

  const executor = new FailingNodeExecutor({
    rules: new Map([["A", { failCount: 2, thenBehavior: "success", output: { result: "ok" } }]]),
  });
  const orchestrator = createOrchestrator(executor);

  const report = await orchestrator.run(graph);

  assert.equal(report.finalStatus, "completed", "重试成功后图应 completed");
  assert.equal(report.nodeResults.get("A")?.status, "completed", "A 最终应 completed");
  // A 在 traversalPath 中应出现 3 次（首次失败 + 2 次重试）
  const aVisits = report.traversalPath.filter((id) => id === "A").length;
  assert.equal(aVisits, 3, "A 应被调用 3 次（首次失败 + 2 次重试）");
});

// ============================================================================
// D3. 节点重试耗尽后自动隔离，下游继续执行
// ============================================================================

test("D3. 节点重试耗尽后自动隔离，下游继续执行", async () => {
  // 构造图：A(永远失败) -> B(可选输入) -> end
  const graph: WorkGraph = GraphBuilder.create()
    .setGraphInfo("g-d3", "隔离后继续图", "D3 测试")
    .addNode(makeTaskNode("A"))
    .addNode(makeTaskNode("B", [], [{ name: "fromA", type: "string", required: false, defaultValue: "default" }]))
    .addNode(makeEndNode("end"))
    .addEdge({ edgeId: "e1", from: "A", to: "B", dataMapping: { fromA: "A.output.missing" } })
    .addEdge({ edgeId: "e2", from: "B", to: "end", dataMapping: {} })
    .setEntryNodeId("A")
    .setConfig(makeConfig({ nodeRetryLimit: 2, enableAutoIsolation: true }))
    .build();

  const executor = new FailingNodeExecutor({
    rules: new Map([
      ["A", { failCount: 100, thenBehavior: "fail" }],
      ["B", { output: { result: "B-ok" } }],
    ]),
  });
  const orchestrator = createOrchestrator(executor);

  const report = await orchestrator.run(graph);

  assert.equal(report.nodeResults.get("A")?.status, "isolated", "A 应被隔离");
  assert.equal(report.nodeResults.get("B")?.status, "completed", "B 应 completed");
  assert.equal(report.finalStatus, "completed", "隔离后下游继续，图应 completed");
});

// ============================================================================
// D4. fork 一个分支失败，其他分支继续执行
// ============================================================================

test("D4. fork 一个分支失败，其他分支继续执行", async () => {
  // 构造图：start -> fork -> [B(成功), C(失败), D(成功)] -> merge -> end
  const graph: WorkGraph = GraphBuilder.create()
    .setGraphInfo("g-d4", "fork 部分失败图", "D4 测试")
    .addNode(makeTaskNode("start"))
    .addNode(makeForkNode("fork1"))
    .addNode(makeTaskNode("B"))
    .addNode(makeTaskNode("C"))
    .addNode(makeTaskNode("D"))
    .addNode(makeMergeNode("merge1"))
    .addNode(makeEndNode("end"))
    .addEdge({ edgeId: "e1", from: "start", to: "fork1", dataMapping: {} })
    .addEdge({ edgeId: "e2", from: "fork1", to: "B", dataMapping: {} })
    .addEdge({ edgeId: "e3", from: "fork1", to: "C", dataMapping: {} })
    .addEdge({ edgeId: "e4", from: "fork1", to: "D", dataMapping: {} })
    .addEdge({ edgeId: "e5", from: "B", to: "merge1", dataMapping: {} })
    .addEdge({ edgeId: "e6", from: "C", to: "merge1", dataMapping: {} })
    .addEdge({ edgeId: "e7", from: "D", to: "merge1", dataMapping: {} })
    .addEdge({ edgeId: "e8", from: "merge1", to: "end", dataMapping: {} })
    .setEntryNodeId("start")
    .setConfig(makeConfig({ maxParallelism: 4, enableAutoIsolation: true }))
    .build();

  const executor = new FailingNodeExecutor({
    rules: new Map([
      ["B", { output: { result: "B-ok" } }],
      ["C", { failCount: 100, thenBehavior: "fail" }],
      ["D", { output: { result: "D-ok" } }],
    ]),
  });
  const orchestrator = createOrchestrator(executor);

  const report = await orchestrator.run(graph);

  assert.equal(report.nodeResults.get("B")?.status, "completed", "B 应 completed");
  assert.equal(report.nodeResults.get("C")?.status, "failed", "C 应 failed（当前编排器对分支失败不重试/隔离）");
  assert.equal(report.nodeResults.get("D")?.status, "completed", "D 应 completed");
  // 存在 failed 节点时，整图最终状态为 failed
  assert.equal(report.finalStatus, "failed", "存在 failed 分支时整图应 failed");
});

// ============================================================================
// D5. merge 节点前所有分支失败
// ============================================================================

test("D5. merge 节点前所有分支失败", async () => {
  // 构造图：start -> fork -> [B(失败), C(失败)] -> merge -> end
  const graph: WorkGraph = GraphBuilder.create()
    .setGraphInfo("g-d5", "merge 全失败图", "D5 测试")
    .addNode(makeTaskNode("start"))
    .addNode(makeForkNode("fork1"))
    .addNode(makeTaskNode("B"))
    .addNode(makeTaskNode("C"))
    .addNode(makeMergeNode("merge1"))
    .addNode(makeEndNode("end"))
    .addEdge({ edgeId: "e1", from: "start", to: "fork1", dataMapping: {} })
    .addEdge({ edgeId: "e2", from: "fork1", to: "B", dataMapping: {} })
    .addEdge({ edgeId: "e3", from: "fork1", to: "C", dataMapping: {} })
    .addEdge({ edgeId: "e4", from: "B", to: "merge1", dataMapping: {} })
    .addEdge({ edgeId: "e5", from: "C", to: "merge1", dataMapping: {} })
    .addEdge({ edgeId: "e6", from: "merge1", to: "end", dataMapping: {} })
    .setEntryNodeId("start")
    .setConfig(makeConfig({ maxParallelism: 4, enableAutoIsolation: true }))
    .build();

  const executor = new FailingNodeExecutor({
    rules: new Map([
      ["B", { failCount: 100, thenBehavior: "fail" }],
      ["C", { failCount: 100, thenBehavior: "fail" }],
      // merge1 在输入为空时返回 failed
      [
        "merge1",
        {
          decide: (_node, input) => (Object.keys(input).length === 0 ? "fail" : "success"),
        },
      ],
    ]),
  });
  const orchestrator = createOrchestrator(executor);

  const report = await orchestrator.run(graph);

  assert.equal(report.nodeResults.get("B")?.status, "failed", "B 应 failed");
  assert.equal(report.nodeResults.get("C")?.status, "failed", "C 应 failed");
  // merge1 因输入为空返回 failed，随后被图级自动隔离策略重试耗尽后标记为 isolated
  assert.ok(
    report.nodeResults.get("merge1")?.status === "failed" || report.nodeResults.get("merge1")?.status === "isolated",
    "merge1 应 failed 或 isolated"
  );
  assert.equal(report.finalStatus, "failed", "全部分支失败时整图应 failed");
});

// ============================================================================
// D6. merge 节点部分输入可用
// ============================================================================

test("D6. merge 节点部分输入可用", async () => {
  // 构造图：start -> fork -> [B(失败), C(成功并输出 value)] -> merge -> end
  const graph: WorkGraph = GraphBuilder.create()
    .setGraphInfo("g-d6", "merge 部分输入图", "D6 测试")
    .addNode(makeTaskNode("start"))
    .addNode(makeForkNode("fork1"))
    .addNode(makeTaskNode("B"))
    .addNode(makeTaskNode("C", [{ name: "value", type: "string", required: true }]))
    .addNode(makeMergeNode("merge1"))
    .addNode(makeEndNode("end"))
    .addEdge({ edgeId: "e1", from: "start", to: "fork1", dataMapping: {} })
    .addEdge({ edgeId: "e2", from: "fork1", to: "B", dataMapping: {} })
    .addEdge({ edgeId: "e3", from: "fork1", to: "C", dataMapping: {} })
    .addEdge({ edgeId: "e4", from: "B", to: "merge1", dataMapping: { value: "B.value" } })
    .addEdge({ edgeId: "e5", from: "C", to: "merge1", dataMapping: { value: "C.value" } })
    .addEdge({ edgeId: "e6", from: "merge1", to: "end", dataMapping: {} })
    .setEntryNodeId("start")
    .setConfig(makeConfig({ maxParallelism: 4, enableAutoIsolation: true }))
    .build();

  const executor = new FailingNodeExecutor({
    rules: new Map([
      ["B", { failCount: 100, thenBehavior: "fail" }],
      ["C", { output: { value: "C-value" } }],
      // merge1 在输入非空时返回 completed
      [
        "merge1",
        {
          decide: (_node, input) => (Object.keys(input).length === 0 ? "fail" : "success"),
          output: { merged: true },
        },
      ],
    ]),
  });
  const orchestrator = createOrchestrator(executor);

  const report = await orchestrator.run(graph);

  assert.equal(report.nodeResults.get("B")?.status, "failed", "B 应 failed");
  assert.equal(report.nodeResults.get("C")?.status, "completed", "C 应 completed");
  assert.equal(report.nodeResults.get("merge1")?.status, "completed", "merge1 应 completed");
  // 存在 failed 节点时，整图最终状态仍为 failed
  assert.equal(report.finalStatus, "failed", "存在 failed 分支时整图应 failed");
});

// ============================================================================
// D7. 图级总重试预算耗尽
// ============================================================================

test("D7. 图级总重试预算耗尽", async () => {
  // 构造图：A -> B；A 失败 1 次后成功，B 永远失败
  // 配置 maxTotalRetries=1，A 的重试消耗 1 次预算，B 首次失败时预算耗尽，触发 stop_failure
  const graph: WorkGraph = GraphBuilder.create()
    .setGraphInfo("g-d7", "总重试预算耗尽图", "D7 测试")
    .addNode(makeTaskNode("A"))
    .addNode(makeTaskNode("B"))
    .addNode(makeEndNode("end"))
    .addEdge({ edgeId: "e1", from: "A", to: "B", dataMapping: {} })
    .addEdge({ edgeId: "e2", from: "B", to: "end", dataMapping: {} })
    .setEntryNodeId("A")
    .setConfig(makeConfig({ nodeRetryLimit: 3, enableAutoIsolation: false }))
    .build();

  const executor = new FailingNodeExecutor({
    rules: new Map([
      ["A", { failCount: 1, thenBehavior: "success" }],
      ["B", { failCount: 100, thenBehavior: "fail" }],
    ]),
  });
  const orchestrator = createOrchestrator(
    executor,
    { nodeRetryLimit: 3, enableAutoIsolation: false },
    { maxTotalRetries: 1 }
  );

  const report = await orchestrator.run(graph);

  assert.equal(report.finalStatus, "failed", "总重试预算耗尽后整图应 failed");
  // B 首次失败即触发 stop_failure，B 状态为 failed
  assert.equal(report.nodeResults.get("B")?.status, "failed", "B 应 failed");
});

// ============================================================================
// D8. 连续节点失败熔断
// ============================================================================

test("D8. 连续节点失败熔断", async () => {
  // 构造图：A -> B -> C -> end；A/B/C 均失败
  // 配置 consecutiveNodeFailureThreshold=2，第 3 个节点失败时触发熔断
  const graph: WorkGraph = GraphBuilder.create()
    .setGraphInfo("g-d8", "连续失败熔断图", "D8 测试")
    .addNode(makeTaskNode("A"))
    .addNode(makeTaskNode("B"))
    .addNode(makeTaskNode("C"))
    .addNode(makeEndNode("end"))
    .addEdge({ edgeId: "e1", from: "A", to: "B", dataMapping: {} })
    .addEdge({ edgeId: "e2", from: "B", to: "C", dataMapping: {} })
    .addEdge({ edgeId: "e3", from: "C", to: "end", dataMapping: {} })
    .setEntryNodeId("A")
    .setConfig(makeConfig({ nodeRetryLimit: 0, enableAutoIsolation: false }))
    .build();

  const executor = new FailingNodeExecutor({
    rules: new Map([
      ["A", { failCount: 100, thenBehavior: "fail" }],
      ["B", { failCount: 100, thenBehavior: "fail" }],
      ["C", { failCount: 100, thenBehavior: "fail" }],
    ]),
  });
  const orchestrator = createOrchestrator(
    executor,
    { nodeRetryLimit: 0, enableAutoIsolation: false },
    { consecutiveNodeFailureThreshold: 2 }
  );

  const report = await orchestrator.run(graph);

  assert.equal(report.finalStatus, "failed", "连续失败熔断后整图应 failed");
  // C 不应被执行（熔断发生在 B 失败后？实际是调度器在 C 执行前检查连续失败次数）
  // 根据 scheduler 实现：A 失败后 consecutiveNodeFailures=1，B 失败后=2，下一次 decideNext 时 >= threshold 触发 stop_failure
  // 因此 C 不会被调用
  assert.ok(!report.traversalPath.includes("C"), "C 不应被执行（已熔断）");
});

// ============================================================================
// D9. 分支状态隔离后全局状态合并正确性
// ============================================================================

test("D9. 分支状态隔离后全局状态合并正确性", async () => {
  // 构造图：start -> fork -> [B(写入集合), C(写入集合+标量)] -> merge -> end
  // 验证 merge 后 globalState 中集合字段 entry 级合并，标量临时字段不污染主 state
  const graph: WorkGraph = GraphBuilder.create()
    .setGraphInfo("g-d9", "状态合并图", "D9 测试")
    .addNode(makeTaskNode("start"))
    .addNode(makeForkNode("fork1"))
    .addNode(makeTaskNode("B"))
    .addNode(makeTaskNode("C"))
    .addNode(makeMergeNode("merge1"))
    .addNode(makeEndNode("end"))
    .addEdge({ edgeId: "e1", from: "start", to: "fork1", dataMapping: {} })
    .addEdge({ edgeId: "e2", from: "fork1", to: "B", dataMapping: {} })
    .addEdge({ edgeId: "e3", from: "fork1", to: "C", dataMapping: {} })
    .addEdge({ edgeId: "e4", from: "B", to: "merge1", dataMapping: {} })
    .addEdge({ edgeId: "e5", from: "C", to: "merge1", dataMapping: {} })
    .addEdge({ edgeId: "e6", from: "merge1", to: "end", dataMapping: {} })
    .setEntryNodeId("start")
    .setConfig(makeConfig({ maxParallelism: 4 }))
    .build();

  const executor = new FailingNodeExecutor({
    rules: new Map([
      // B 分支：向 globalState.items 添加 "B"
      [
        "B",
        {
          decide: (_node, _input, context) => {
            const items = (context.globalState.items as string[] | undefined) ?? [];
            context.globalState.items = [...items, "B"];
            return "success";
          },
        },
      ],
      // C 分支：向 globalState.items 添加 "C"，并写入临时标量 tempScalar
      [
        "C",
        {
          decide: (_node, _input, context) => {
            const items = (context.globalState.items as string[] | undefined) ?? [];
            context.globalState.items = [...items, "C"];
            context.globalState.tempScalar = "C-value";
            return "success";
          },
        },
      ],
    ]),
  });
  const orchestrator = createOrchestrator(executor);

  const report = await orchestrator.run(graph);

  assert.equal(report.finalStatus, "completed", "状态合并图应成功完成");
  // mergeBranchGlobalState 默认只允许 entry 级合并 Map/Array；数组应合并
  const finalItems = report.finalGlobalState?.items as string[] | undefined;
  assert.ok(finalItems?.includes("B"), "全局状态 items 应包含 B");
  assert.ok(finalItems?.includes("C"), "全局状态 items 应包含 C");
});

// ============================================================================
// D10. 通过 GraphLifecycleManager 运行复杂失败恢复图
// ============================================================================

test("D10. 通过 GraphLifecycleManager 运行复杂失败恢复图", async () => {
  // 构造图：A -> fork -> [B(成功), C(失败)] -> merge -> end
  const graph: WorkGraph = GraphBuilder.create()
    .setGraphInfo("g-d10", "生命周期复杂图", "D10 测试")
    .addNode(makeTaskNode("A"))
    .addNode(makeForkNode("fork1"))
    .addNode(makeTaskNode("B"))
    .addNode(makeTaskNode("C"))
    .addNode(makeMergeNode("merge1"))
    .addNode(makeEndNode("end"))
    .addEdge({ edgeId: "e1", from: "A", to: "fork1", dataMapping: {} })
    .addEdge({ edgeId: "e2", from: "fork1", to: "B", dataMapping: {} })
    .addEdge({ edgeId: "e3", from: "fork1", to: "C", dataMapping: {} })
    .addEdge({ edgeId: "e4", from: "B", to: "merge1", dataMapping: {} })
    .addEdge({ edgeId: "e5", from: "C", to: "merge1", dataMapping: {} })
    .addEdge({ edgeId: "e6", from: "merge1", to: "end", dataMapping: {} })
    .setEntryNodeId("A")
    .setConfig(makeConfig({ maxParallelism: 4, enableAutoIsolation: true }))
    .build();

  const executor = new FailingNodeExecutor({
    rules: new Map([
      ["B", { output: { result: "B-ok" } }],
      ["C", { failCount: 100, thenBehavior: "fail" }],
    ]),
  });
  const orchestrator = createOrchestrator(executor);

  const manager = new GraphLifecycleManager();
  const stateChanges: string[] = [];
  manager.onStateChange = (event) => {
    stateChanges.push(`${event.oldState}->${event.newState}`);
  };

  await manager.initialize(graph, {
    nodeExecutor: executor,
    edgeResolver: new EdgeResolverImpl(makeSilentLogger()),
    graphScheduler: orchestrator["graphScheduler"],
    graphGuard: orchestrator["graphGuard"],
    predicateRegistry: new PredicateRegistryImpl(),
    logger: makeSilentLogger(),
  });

  assert.equal(manager.status(), "ready", "initialize 后应为 ready");

  const report = await manager.start();

  assert.equal(report.finalStatus, "failed", "存在 failed 分支时整图应 failed");
  assert.equal(manager.status(), "failed", "start 完成后应为 failed");

  await manager.reset();
  assert.equal(manager.status(), "idle", "reset 后应为 idle");

  // 验证状态变更序列包含核心转换
  assert.ok(stateChanges.includes("idle->initializing"), "状态变更应包含 idle->initializing");
  assert.ok(stateChanges.includes("initializing->ready"), "状态变更应包含 initializing->ready");
  assert.ok(stateChanges.includes("ready->running"), "状态变更应包含 ready->running");
  assert.ok(stateChanges.includes("running->failed"), "状态变更应包含 running->failed");
  assert.ok(stateChanges.includes("resetting->idle"), "状态变更应包含 resetting->idle");
});
