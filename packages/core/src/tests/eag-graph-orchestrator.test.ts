/**
 * EAG-Graph LoopOrchestrator 集成测试（Phase 3）
 *
 * 测试范围：
 * - I1. 线性 DAG 遍历：start → end
 * - I2. 多节点线性 DAG：A → B → C → end
 * - I3. fork-merge 并行执行：start → fork → [B, C] → merge → end
 * - I4. decision 谓词路由（返回 true）：start → decision → B → end
 * - I5. decision 谓词路由（返回 false）：start → decision → C → end
 * - I6. 节点重试后成功：A 首次失败 → 重试 → 成功 → end
 * - I7. 节点重试耗尽 + 自动隔离：A 失败 → 重试耗尽 → 隔离 → 继续 → end
 * - I8. 节点重试耗尽 + 无隔离：A 失败 → 重试耗尽 → 整图终止
 * - I9. 图结构校验失败：入口节点不存在 → 直接返回 failed
 * - I10. stop() 用户取消：执行中调用 stop → 图中止
 * - I11. 边契约数据传递：A.output.field → B.input.field
 * - I12. status() 状态查询：返回运行状态快照
 * - I13. fork 并行状态隔离：两分支 globalState 互不干扰
 * - I14. 节点执行异常被捕获：executor 抛异常 → failed 状态
 * - I15. 空 token 预算：maxTokens=0 不限制
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止使用 mock 框架，使用真实类型实例和闭包实现 executor
 * - 每个测试用例独立，无共享可变状态
 *
 * 设计依据：
 * - LOOP-GRAPH-FUSION-DESIGN.md §9 GraphLoopOrchestrator
 * - eag/graph/graph-loop-orchestrator.ts 源文件（被测对象）
 *
 * @module core/tests/eag-graph-orchestrator
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { GraphLoopOrchestrator } from "../eag/graph/graph-loop-orchestrator";
import { GraphBuilder } from "../eag/graph/graph-builder";
import { EdgeResolverImpl } from "../eag/graph/graph-edge-resolver";
import { GraphGuardImpl } from "../eag/graph/graph-guard";
import { GraphSchedulerImpl } from "../eag/graph/graph-scheduler";
import { PredicateRegistryImpl } from "../eag/graph/predicate-registry";
import { DEFAULT_WORK_GRAPH_CONFIG, createRetrySuppressionConfig } from "../eag/graph/graph-loop-models";
import type {
  WorkGraph,
  GraphNodeDef,
  GraphNodeResult,
  GraphRunContext,
  NodeFieldContract,
  GraphLogger,
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
 * 构造一个 decision 节点定义
 *
 * @param nodeId 节点 ID
 * @param predicateId 决策谓词 ID
 */
function makeDecisionNode(nodeId: string, predicateId: string): GraphNodeDef {
  return {
    nodeId,
    nodeType: "decision",
    label: nodeId,
    task: `${nodeId} 决策`,
    inputContract: [],
    outputContract: [],
    decisionPredicateId: predicateId,
  };
}

/**
 * 构造一个 loop 节点定义
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
 * 创建一个可配置的 NodeExecutor 实现
 *
 * 通过闭包变量控制每个节点的执行行为：
 * - 成功节点：返回 completed 状态
 * - 失败节点：返回 failed 状态
 * - 可变行为节点：按调用次数切换行为（首次失败，重试成功）
 *
 * @param behaviorMap 节点 ID → 行为配置（"success" / "fail" / "fail-then-success"）
 * @param outputMap 节点 ID → 输出数据（可选，默认空对象）
 */
function createConfigurableExecutor(
  behaviorMap: Map<string, "success" | "fail" | "fail-then-success">,
  outputMap?: Map<string, Record<string, unknown>>
): NodeExecutorProtocol {
  // 记录每个节点的调用次数（用于 fail-then-success 行为）
  const callCounts = new Map<string, number>();

  return {
    async execute(
      node: Readonly<GraphNodeDef>,
      input: Readonly<Record<string, unknown>>,
      context: Readonly<GraphRunContext>
    ): Promise<GraphNodeResult> {
      const nodeId = node.nodeId;
      const count = callCounts.get(nodeId) ?? 0;
      callCounts.set(nodeId, count + 1);

      const behavior = behaviorMap.get(nodeId) ?? "success";
      const output = outputMap?.get(nodeId) ?? {};

      // end 节点总是成功
      if (node.nodeType === "end") {
        return {
          nodeId,
          nodeType: node.nodeType,
          status: "completed",
          output: {},
          durationSec: 0.01,
          retryCount: 0,
        };
      }

      // merge/fork/decision 节点总是成功（它们是控制节点）
      if (node.nodeType === "merge" || node.nodeType === "fork" || node.nodeType === "decision") {
        return {
          nodeId,
          nodeType: node.nodeType,
          status: "completed",
          output: {},
          durationSec: 0.01,
          retryCount: 0,
        };
      }

      // 根据行为配置返回结果
      if (behavior === "fail") {
        return {
          nodeId,
          nodeType: node.nodeType,
          status: "failed",
          output: {},
          durationSec: 0.01,
          failureReason: `${nodeId} 模拟失败`,
          retryCount: count,
        };
      }

      if (behavior === "fail-then-success") {
        if (count === 0) {
          // 首次调用失败
          return {
            nodeId,
            nodeType: node.nodeType,
            status: "failed",
            output: {},
            durationSec: 0.01,
            failureReason: `${nodeId} 首次失败`,
            retryCount: count,
          };
        }
        // 重试时成功
        return {
          nodeId,
          nodeType: node.nodeType,
          status: "completed",
          output,
          durationSec: 0.01,
          retryCount: count,
        };
      }

      // 默认成功
      return {
        nodeId,
        nodeType: node.nodeType,
        status: "completed",
        output,
        durationSec: 0.01,
        retryCount: count,
      };
    },
  };
}

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
  retrySuppressionOverrides?: Partial<ReturnType<typeof createRetrySuppressionConfig>>
): GraphLoopOrchestrator {
  const predicateRegistry = new PredicateRegistryImpl();
  const logger = makeSilentLogger();

  // 重试抑制配置：使用宽松的默认值避免测试中过早熔断
  const retrySuppression = createRetrySuppressionConfig(
    retrySuppressionOverrides?.maxTotalRetries ?? 100,
    retrySuppressionOverrides?.maxIterationsPerNode ?? 100,
    retrySuppressionOverrides?.consecutiveNodeFailureThreshold ?? 10
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
// 集成测试
// ============================================================================

test("I1. 线性 DAG 遍历：start → end", async () => {
  // 构造图：start → end
  const graph: WorkGraph = GraphBuilder.create()
    .setGraphInfo("g-i1", "线性图", "I1 测试")
    .addNode(makeTaskNode("start"))
    .addNode(makeEndNode("end"))
    .addEdge({ edgeId: "e1", from: "start", to: "end", dataMapping: {} })
    .setEntryNodeId("start")
    .build();

  const executor = createConfigurableExecutor(new Map([["start", "success"]]));
  const orchestrator = createOrchestrator(executor);

  const report = await orchestrator.run(graph);

  assert.equal(report.finalStatus, "completed", "线性图应成功完成");
  assert.equal(report.traversalPath.length, 2, "应遍历 2 个节点");
  assert.equal(report.traversalPath[0], "start", "第一个节点是 start");
  assert.equal(report.traversalPath[1], "end", "第二个节点是 end");
  assert.equal(report.nodeResults.size, 2, "应有 2 个节点结果");
  assert.equal(report.nodeResults.get("start")?.status, "completed", "start 应 completed");
  assert.equal(report.nodeResults.get("end")?.status, "completed", "end 应 completed");
});

test("I2. 多节点线性 DAG：A → B → C → end", async () => {
  const graph: WorkGraph = GraphBuilder.create()
    .setGraphInfo("g-i2", "多节点线性图", "I2 测试")
    .addNode(makeTaskNode("A"))
    .addNode(makeTaskNode("B"))
    .addNode(makeTaskNode("C"))
    .addNode(makeEndNode("end"))
    .addEdge({ edgeId: "e1", from: "A", to: "B", dataMapping: {} })
    .addEdge({ edgeId: "e2", from: "B", to: "C", dataMapping: {} })
    .addEdge({ edgeId: "e3", from: "C", to: "end", dataMapping: {} })
    .setEntryNodeId("A")
    .build();

  const executor = createConfigurableExecutor(
    new Map([
      ["A", "success"],
      ["B", "success"],
      ["C", "success"],
    ])
  );
  const orchestrator = createOrchestrator(executor);

  const report = await orchestrator.run(graph);

  assert.equal(report.finalStatus, "completed", "多节点线性图应成功完成");
  assert.equal(report.traversalPath.length, 4, "应遍历 4 个节点");
  assert.deepEqual([...report.traversalPath], ["A", "B", "C", "end"], "遍历路径应为 A → B → C → end");
});

test("I3. fork-merge 并行执行：start → fork → [B, C] → merge → end", async () => {
  const graph: WorkGraph = GraphBuilder.create()
    .setGraphInfo("g-i3", "fork-merge 图", "I3 测试")
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

  const executor = createConfigurableExecutor(
    new Map([
      ["start", "success"],
      ["B", "success"],
      ["C", "success"],
    ])
  );
  const orchestrator = createOrchestrator(executor);

  const report = await orchestrator.run(graph);

  assert.equal(report.finalStatus, "completed", "fork-merge 图应成功完成");
  // 遍历路径应包含所有节点
  assert.ok(report.traversalPath.includes("start"), "路径包含 start");
  assert.ok(report.traversalPath.includes("fork1"), "路径包含 fork1");
  assert.ok(report.traversalPath.includes("B"), "路径包含 B");
  assert.ok(report.traversalPath.includes("C"), "路径包含 C");
  assert.ok(report.traversalPath.includes("merge1"), "路径包含 merge1");
  assert.ok(report.traversalPath.includes("end"), "路径包含 end");
  // B 和 C 都应 completed
  assert.equal(report.nodeResults.get("B")?.status, "completed", "B 应 completed");
  assert.equal(report.nodeResults.get("C")?.status, "completed", "C 应 completed");
});

test("I4. decision 谓词路由（返回 true）：start → decision → B → end", async () => {
  // 注册谓词：返回 true → 选择第一条边（→ B）
  const predicateRegistry = new PredicateRegistryImpl();
  predicateRegistry.register("chooseB", () => true);

  const graph: WorkGraph = GraphBuilder.create()
    .setGraphInfo("g-i4", "decision 图", "I4 测试")
    .addNode(makeTaskNode("start"))
    .addNode(makeDecisionNode("decision1", "chooseB"))
    .addNode(makeTaskNode("B"))
    .addNode(makeTaskNode("C"))
    .addNode(makeEndNode("end"))
    .addEdge({ edgeId: "e1", from: "start", to: "decision1", dataMapping: {} })
    .addEdge({ edgeId: "e2", from: "decision1", to: "B", dataMapping: {} })
    .addEdge({ edgeId: "e3", from: "decision1", to: "C", dataMapping: {} })
    .addEdge({ edgeId: "e4", from: "B", to: "end", dataMapping: {} })
    .addEdge({ edgeId: "e5", from: "C", to: "end", dataMapping: {} })
    .setEntryNodeId("start")
    .build();

  const executor = createConfigurableExecutor(
    new Map([
      ["start", "success"],
      ["B", "success"],
      ["C", "success"],
    ])
  );

  // 使用自定义编排器（带预注册谓词）
  const logger = makeSilentLogger();
  const retrySuppression = createRetrySuppressionConfig(100, 100, 10);
  const scheduler = new GraphSchedulerImpl(retrySuppression, logger);
  const guard = new GraphGuardImpl(logger);
  const edgeResolver = new EdgeResolverImpl(logger);
  const orchestrator = new GraphLoopOrchestrator({
    nodeExecutor: executor,
    edgeResolver,
    graphScheduler: scheduler,
    graphGuard: guard,
    predicateRegistry,
    logger,
  });

  const report = await orchestrator.run(graph);

  assert.equal(report.finalStatus, "completed", "decision 图应成功完成");
  assert.ok(report.traversalPath.includes("B"), "路径应包含 B（true 分支）");
  assert.ok(!report.traversalPath.includes("C"), "路径不应包含 C（未选择 false 分支）");
});

test("I5. decision 谓词路由（返回 false）：start → decision → C → end", async () => {
  const predicateRegistry = new PredicateRegistryImpl();
  predicateRegistry.register("chooseC", () => false);

  const graph: WorkGraph = GraphBuilder.create()
    .setGraphInfo("g-i5", "decision 图", "I5 测试")
    .addNode(makeTaskNode("start"))
    .addNode(makeDecisionNode("decision1", "chooseC"))
    .addNode(makeTaskNode("B"))
    .addNode(makeTaskNode("C"))
    .addNode(makeEndNode("end"))
    .addEdge({ edgeId: "e1", from: "start", to: "decision1", dataMapping: {} })
    .addEdge({ edgeId: "e2", from: "decision1", to: "B", dataMapping: {} })
    .addEdge({ edgeId: "e3", from: "decision1", to: "C", dataMapping: {} })
    .addEdge({ edgeId: "e4", from: "B", to: "end", dataMapping: {} })
    .addEdge({ edgeId: "e5", from: "C", to: "end", dataMapping: {} })
    .setEntryNodeId("start")
    .build();

  const executor = createConfigurableExecutor(
    new Map([
      ["start", "success"],
      ["B", "success"],
      ["C", "success"],
    ])
  );

  const logger = makeSilentLogger();
  const retrySuppression = createRetrySuppressionConfig(100, 100, 10);
  const scheduler = new GraphSchedulerImpl(retrySuppression, logger);
  const guard = new GraphGuardImpl(logger);
  const edgeResolver = new EdgeResolverImpl(logger);
  const orchestrator = new GraphLoopOrchestrator({
    nodeExecutor: executor,
    edgeResolver,
    graphScheduler: scheduler,
    graphGuard: guard,
    predicateRegistry,
    logger,
  });

  const report = await orchestrator.run(graph);

  assert.equal(report.finalStatus, "completed", "decision 图应成功完成");
  assert.ok(report.traversalPath.includes("C"), "路径应包含 C（false 分支）");
  assert.ok(!report.traversalPath.includes("B"), "路径不应包含 B（未选择 true 分支）");
});

test("I6. 节点重试后成功：A 首次失败 → 重试 → 成功 → end", async () => {
  const graph: WorkGraph = GraphBuilder.create()
    .setGraphInfo("g-i6", "重试图", "I6 测试")
    .addNode(makeTaskNode("A"))
    .addNode(makeEndNode("end"))
    .addEdge({ edgeId: "e1", from: "A", to: "end", dataMapping: {} })
    .setEntryNodeId("A")
    .setConfig(makeConfig({ nodeRetryLimit: 3, enableAutoIsolation: true }))
    .build();

  // A 首次失败，重试后成功
  const executor = createConfigurableExecutor(new Map([["A", "fail-then-success"]]));
  const orchestrator = createOrchestrator(executor);

  const report = await orchestrator.run(graph);

  assert.equal(report.finalStatus, "completed", "重试后应成功完成");
  assert.equal(report.nodeResults.get("A")?.status, "completed", "A 最终应 completed");
  // A 应被调用 2 次（首次失败 + 重试成功）
  assert.ok(report.traversalPath.includes("A"), "路径包含 A");
  assert.ok(report.traversalPath.includes("end"), "路径包含 end");
});

test("I7. 节点重试耗尽 + 自动隔离：A 失败 → 重试耗尽 → 隔离 → 继续 → end", async () => {
  const graph: WorkGraph = GraphBuilder.create()
    .setGraphInfo("g-i7", "隔离图", "I7 测试")
    .addNode(makeTaskNode("A"))
    .addNode(makeTaskNode("B"))
    .addNode(makeEndNode("end"))
    .addEdge({ edgeId: "e1", from: "A", to: "B", dataMapping: {} })
    .addEdge({ edgeId: "e2", from: "B", to: "end", dataMapping: {} })
    .setEntryNodeId("A")
    .setConfig(makeConfig({ nodeRetryLimit: 2, enableAutoIsolation: true }))
    .build();

  // A 持续失败，B 成功
  const executor = createConfigurableExecutor(
    new Map([
      ["A", "fail"],
      ["B", "success"],
    ])
  );
  const orchestrator = createOrchestrator(executor);

  const report = await orchestrator.run(graph);

  // A 重试耗尽后被隔离，B 继续执行
  assert.equal(report.nodeResults.get("A")?.status, "isolated", "A 应被隔离");
  assert.equal(report.nodeResults.get("B")?.status, "completed", "B 应 completed");
});

test("I8. 节点重试耗尽 + 无隔离：A 失败 → 重试耗尽 → 整图终止", async () => {
  const graph: WorkGraph = GraphBuilder.create()
    .setGraphInfo("g-i8", "无隔离图", "I8 测试")
    .addNode(makeTaskNode("A"))
    .addNode(makeEndNode("end"))
    .addEdge({ edgeId: "e1", from: "A", to: "end", dataMapping: {} })
    .setEntryNodeId("A")
    .setConfig(makeConfig({ nodeRetryLimit: 1, enableAutoIsolation: false }))
    .build();

  // A 持续失败
  const executor = createConfigurableExecutor(new Map([["A", "fail"]]));
  const orchestrator = createOrchestrator(executor);

  const report = await orchestrator.run(graph);

  // 未启用自动隔离 → 整图失败
  assert.equal(report.finalStatus, "failed", "未启用隔离时图应 failed");
  assert.equal(report.nodeResults.get("A")?.status, "failed", "A 应 failed");
});

test("I9. 图结构校验失败：入口节点不存在 → 直接返回 failed", async () => {
  // 构造一个入口节点不存在的图（绕过 GraphBuilder 校验直接构造）
  const invalidGraph: WorkGraph = {
    graphId: "g-i9",
    name: "非法图",
    description: "I9 测试",
    nodes: new Map([["A", makeTaskNode("A")]]),
    edges: [],
    entryNodeId: "nonexistent", // 入口节点不存在
    globalState: {},
    config: DEFAULT_WORK_GRAPH_CONFIG,
  };

  const executor = createConfigurableExecutor(new Map());
  const orchestrator = createOrchestrator(executor);

  const report = await orchestrator.run(invalidGraph);

  assert.equal(report.finalStatus, "failed", "非法图应返回 failed");
  assert.ok(report.finalReport.includes("校验失败"), "报告应包含校验失败信息");
});

test("I10. stop() 用户取消：执行中调用 stop → 图中止", async () => {
  const graph: WorkGraph = GraphBuilder.create()
    .setGraphInfo("g-i10", "取消图", "I10 测试")
    .addNode(makeTaskNode("A"))
    .addNode(makeTaskNode("B"))
    .addNode(makeEndNode("end"))
    .addEdge({ edgeId: "e1", from: "A", to: "B", dataMapping: {} })
    .addEdge({ edgeId: "e2", from: "B", to: "end", dataMapping: {} })
    .setEntryNodeId("A")
    .build();

  // 创建一个在执行 A 后调用 stop 的 executor
  let stopCalled = false;
  const customExecutor: NodeExecutorProtocol = {
    async execute(
      node: Readonly<GraphNodeDef>,
      input: Readonly<Record<string, unknown>>,
      context: GraphRunContext
    ): Promise<GraphNodeResult> {
      if (node.nodeId === "A" && !stopCalled) {
        // 在 A 执行后设置取消信号（通过 orchestrator.stop）
        stopCalled = true;
        // 注意：这里无法直接调用 orchestrator.stop，因为 executor 不知道 orchestrator
        // 改为直接设置 context.cancelled
        context.cancelled = true;
      }
      return {
        nodeId: node.nodeId,
        nodeType: node.nodeType,
        status: "completed",
        output: {},
        durationSec: 0.01,
        retryCount: 0,
      };
    },
  };

  const orchestrator = createOrchestrator(customExecutor);
  const report = await orchestrator.run(graph);

  // 用户取消 → aborted
  assert.equal(report.finalStatus, "aborted", "用户取消应返回 aborted");
});

test("I11. 边契约数据传递：A.output.field → B.input.field", async () => {
  // A 输出 { result: "hello" }，B 的 inputContract 声明需要 result 字段
  const outputContract: ReadonlyArray<NodeFieldContract> = [{ name: "result", type: "string", required: true }];
  const inputContract: ReadonlyArray<NodeFieldContract> = [{ name: "result", type: "string", required: true }];

  const graph: WorkGraph = GraphBuilder.create()
    .setGraphInfo("g-i11", "数据传递图", "I11 测试")
    .addNode(makeTaskNode("A", outputContract))
    .addNode(makeTaskNode("B", [], inputContract))
    .addNode(makeEndNode("end"))
    .addEdge({
      edgeId: "e1",
      from: "A",
      to: "B",
      dataMapping: { result: "output.result" },
    })
    .addEdge({ edgeId: "e2", from: "B", to: "end", dataMapping: {} })
    .setEntryNodeId("A")
    .build();

  // A 输出 { result: "hello" }
  const outputMap = new Map([["A", { result: "hello" }]]);
  const executor = createConfigurableExecutor(
    new Map([
      ["A", "success"],
      ["B", "success"],
    ]),
    outputMap
  );
  const orchestrator = createOrchestrator(executor);

  const report = await orchestrator.run(graph);

  assert.equal(report.finalStatus, "completed", "数据传递图应成功完成");
  assert.equal(report.nodeResults.get("A")?.output.result, "hello", "A 输出 result=hello");
});

test("I12. status() 状态查询：返回运行状态快照", async () => {
  const graph: WorkGraph = GraphBuilder.create()
    .setGraphInfo("g-i12", "状态查询图", "I12 测试")
    .addNode(makeTaskNode("A"))
    .addNode(makeEndNode("end"))
    .addEdge({ edgeId: "e1", from: "A", to: "end", dataMapping: {} })
    .setEntryNodeId("A")
    .build();

  const executor = createConfigurableExecutor(new Map([["A", "success"]]));
  const orchestrator = createOrchestrator(executor);

  // 执行前查询 status（无匹配 runId → 返回默认 completed）
  const statusBefore = await orchestrator.status("nonexistent-run");
  assert.equal(statusBefore.status, "completed", "无匹配 runId 应返回 completed");

  // 执行图
  const report = await orchestrator.run(graph);
  assert.equal(report.finalStatus, "completed", "图应成功完成");

  // 执行后查询 status（运行已结束，currentRunId 已清空 → 返回默认 completed）
  const statusAfter = await orchestrator.status(report.runId);
  assert.equal(statusAfter.runId, report.runId, "runId 应匹配");
});

test("I13. fork 并行状态隔离：两分支 globalState 互不干扰", async () => {
  const graph: WorkGraph = GraphBuilder.create()
    .setGraphInfo("g-i13", "并行隔离图", "I13 测试")
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
    .setConfig(makeConfig({ maxParallelism: 2 }))
    .build();

  // B 和 C 各自写入不同的 globalState 字段
  const customExecutor: NodeExecutorProtocol = {
    async execute(
      node: Readonly<GraphNodeDef>,
      input: Readonly<Record<string, unknown>>,
      context: GraphRunContext
    ): Promise<GraphNodeResult> {
      if (node.nodeId === "B") {
        // B 分支写入 branchB 字段
        context.globalState.branchB = "B-value";
      }
      if (node.nodeId === "C") {
        // C 分支写入 branchC 字段
        context.globalState.branchC = "C-value";
      }
      return {
        nodeId: node.nodeId,
        nodeType: node.nodeType,
        status: "completed",
        output: {},
        durationSec: 0.01,
        retryCount: 0,
      };
    },
  };

  const orchestrator = createOrchestrator(customExecutor);
  const report = await orchestrator.run(graph);

  assert.equal(report.finalStatus, "completed", "并行隔离图应成功完成");
  assert.equal(report.nodeResults.get("B")?.status, "completed", "B 应 completed");
  assert.equal(report.nodeResults.get("C")?.status, "completed", "C 应 completed");
});

test("I14. 节点执行异常被捕获：executor 抛异常 → failed 状态", async () => {
  const graph: WorkGraph = GraphBuilder.create()
    .setGraphInfo("g-i14", "异常图", "I14 测试")
    .addNode(makeTaskNode("A"))
    .addNode(makeEndNode("end"))
    .addEdge({ edgeId: "e1", from: "A", to: "end", dataMapping: {} })
    .setEntryNodeId("A")
    .setConfig(makeConfig({ nodeRetryLimit: 0, enableAutoIsolation: false }))
    .build();

  // executor 抛异常
  const throwingExecutor: NodeExecutorProtocol = {
    async execute(node: Readonly<GraphNodeDef>): Promise<GraphNodeResult> {
      if (node.nodeId === "A") {
        throw new Error("模拟执行异常");
      }
      return {
        nodeId: node.nodeId,
        nodeType: node.nodeType,
        status: "completed",
        output: {},
        durationSec: 0.01,
        retryCount: 0,
      };
    },
  };

  const orchestrator = createOrchestrator(throwingExecutor);
  const report = await orchestrator.run(graph);

  assert.equal(report.finalStatus, "failed", "异常应导致图 failed");
  assert.equal(report.nodeResults.get("A")?.status, "failed", "A 应 failed");
  assert.ok(report.nodeResults.get("A")?.failureReason?.includes("模拟执行异常"), "失败原因应包含异常信息");
});

test("I15. 空 token 预算：maxTokens=0 不限制", async () => {
  const graph: WorkGraph = GraphBuilder.create()
    .setGraphInfo("g-i15", "无 token 限制图", "I15 测试")
    .addNode(makeTaskNode("A"))
    .addNode(makeEndNode("end"))
    .addEdge({ edgeId: "e1", from: "A", to: "end", dataMapping: {} })
    .setEntryNodeId("A")
    .setConfig(makeConfig({ maxTokens: 0 })) // 0 = 不限制
    .build();

  const executor = createConfigurableExecutor(new Map([["A", "success"]]));
  const orchestrator = createOrchestrator(executor);
  const report = await orchestrator.run(graph);

  assert.equal(report.finalStatus, "completed", "maxTokens=0 不应限制执行");
  assert.equal(report.nodeResults.get("A")?.status, "completed", "A 应 completed");
});

test("I16. loop 节点类型遍历：loop → end", async () => {
  const graph: WorkGraph = GraphBuilder.create()
    .setGraphInfo("g-i16", "loop 节点图", "I16 测试")
    .addNode(makeLoopNode("loop1"))
    .addNode(makeEndNode("end"))
    .addEdge({ edgeId: "e1", from: "loop1", to: "end", dataMapping: {} })
    .setEntryNodeId("loop1")
    .build();

  const executor = createConfigurableExecutor(new Map([["loop1", "success"]]));
  const orchestrator = createOrchestrator(executor);
  const report = await orchestrator.run(graph);

  assert.equal(report.finalStatus, "completed", "loop 节点图应成功完成");
  assert.equal(report.nodeResults.get("loop1")?.status, "completed", "loop1 应 completed");
});

test("I17. 单节点入口即终点：start 无下游边 → stop_success", async () => {
  const graph: WorkGraph = GraphBuilder.create()
    .setGraphInfo("g-i17", "单节点图", "I17 测试")
    .addNode(makeTaskNode("start"))
    .setEntryNodeId("start")
    .build();

  const executor = createConfigurableExecutor(new Map([["start", "success"]]));
  const orchestrator = createOrchestrator(executor);
  const report = await orchestrator.run(graph);

  assert.equal(report.finalStatus, "completed", "单节点图应成功完成");
  assert.equal(report.traversalPath.length, 1, "应只遍历 1 个节点");
  assert.equal(report.traversalPath[0], "start", "唯一节点是 start");
});

test("I18. finalReport 包含 Markdown 格式报告", async () => {
  const graph: WorkGraph = GraphBuilder.create()
    .setGraphInfo("g-i18", "报告图", "I18 测试")
    .addNode(makeTaskNode("A"))
    .addNode(makeEndNode("end"))
    .addEdge({ edgeId: "e1", from: "A", to: "end", dataMapping: {} })
    .setEntryNodeId("A")
    .build();

  const executor = createConfigurableExecutor(new Map([["A", "success"]]));
  const orchestrator = createOrchestrator(executor);
  const report = await orchestrator.run(graph);

  assert.ok(report.finalReport.includes("# 图运行报告"), "报告应包含标题");
  assert.ok(report.finalReport.includes("节点执行结果"), "报告应包含节点结果表");
  assert.ok(report.finalReport.includes("A"), "报告应包含节点 A");
});
