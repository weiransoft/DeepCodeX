/**
 * 图生命周期管理器单元测试（TOP-1）
 *
 * 测试范围：
 * - L1. 正常状态流转：idle → initializing → ready → running → completed → resetting → idle
 * - L2. 非法状态转换：start() 在 idle / running 等状态报错
 * - L3. 非法状态转换：initialize() 在 running / stopping / resetting 状态报错
 * - L4. reset() 在 running / stopping 状态报错
 * - L5. stop() 后状态迁移到 stopping，start() Promise 完成后进入 failed
 * - L6. 状态变更监听器按顺序触发，并携带正确事件信息
 * - L7. 监听器异常不中断状态转换流程
 * - L8. 多次 initialize → start → reset 循环可复用同一管理器实例
 * - L9. start() 抛异常时状态进入 failed
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止使用 mock 框架，使用真实类型实例和闭包实现
 * - 每个测试用例独立，无共享可变状态
 *
 * 设计依据：
 * - docs/superpowers/plans/2026-07-23-eag-graph-top5-improvements.md 阶段 C
 * - eag/graph/graph-lifecycle-manager.ts 源文件（被测对象）
 *
 * @module core/tests/graph-lifecycle-manager
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { GraphLifecycleManager } from "../eag/graph/graph-lifecycle-manager";
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
  GraphLifecycleState,
  GraphLifecycleStateChangeEvent,
} from "../eag/graph/graph-loop-models";
import type { NodeExecutorProtocol, GraphLoopOrchestratorOptions } from "../eag/graph/graph-loop-protocols";

// ============================================================================
// 辅助：构造测试数据
// ============================================================================

/**
 * 构造一个 task 节点定义
 *
 * @param nodeId 节点 ID
 */
function makeTaskNode(nodeId: string): GraphNodeDef {
  return {
    nodeId,
    nodeType: "task",
    label: nodeId,
    task: `${nodeId} 任务`,
    inputContract: [],
    outputContract: [],
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
 * 构造一个简单的线性图（start → end）
 *
 * @param graphId 图 ID
 */
function makeLinearGraph(graphId: string = "g-lifecycle"): WorkGraph {
  return GraphBuilder.create()
    .setGraphInfo(graphId, "生命周期测试线性图", "TOP-1 生命周期测试")
    .addNode(makeTaskNode("start"))
    .addNode(makeEndNode("end"))
    .addEdge({ edgeId: "e1", from: "start", to: "end", dataMapping: {} })
    .setEntryNodeId("start")
    .build();
}

/**
 * 创建默认的成功节点执行器（所有节点都 completed）
 */
function makeSuccessExecutor(): NodeExecutorProtocol {
  return {
    async execute(
      node: Readonly<GraphNodeDef>,
      _input: Readonly<Record<string, unknown>>,
      _context: Readonly<GraphRunContext>
    ): Promise<GraphNodeResult> {
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
}

/**
 * 创建可触发异常的节点执行器
 *
 * 当执行指定节点时抛出异常，用于验证 start() 异常路径。
 */
function makeThrowingExecutor(failingNodeId: string): NodeExecutorProtocol {
  return {
    async execute(
      node: Readonly<GraphNodeDef>,
      _input: Readonly<Record<string, unknown>>,
      _context: Readonly<GraphRunContext>
    ): Promise<GraphNodeResult> {
      if (node.nodeId === failingNodeId) {
        throw new Error(`${failingNodeId} 模拟执行异常`);
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
}

/**
 * 创建慢速节点执行器（用于 stop() 测试）
 *
 * 指定节点执行时会异步等待一段时间，期间可调用 stop() 触发取消。
 */
function makeSlowExecutor(slowNodeId: string, delayMs: number): NodeExecutorProtocol {
  return {
    async execute(
      node: Readonly<GraphNodeDef>,
      _input: Readonly<Record<string, unknown>>,
      context: Readonly<GraphRunContext>
    ): Promise<GraphNodeResult> {
      // 如果是慢速节点，循环检查取消信号并延迟
      if (node.nodeId === slowNodeId) {
        const startAt = Date.now();
        while (Date.now() - startAt < delayMs) {
          if (context.cancelled) {
            return {
              nodeId: node.nodeId,
              nodeType: node.nodeType,
              status: "failed",
              output: {},
              durationSec: (Date.now() - startAt) / 1000,
              failureReason: "用户取消",
              retryCount: 0,
            };
          }
          // 小步等待，避免阻塞事件循环
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
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
}

/**
 * 创建完整的编排器构造选项（使用真实组件）
 *
 * @param executor 节点执行器
 */
function makeOrchestratorOptions(executor: NodeExecutorProtocol): GraphLoopOrchestratorOptions {
  const predicateRegistry = new PredicateRegistryImpl();
  const logger = makeSilentLogger();
  const retrySuppression = createRetrySuppressionConfig(100, 100, 10);
  const scheduler = new GraphSchedulerImpl(retrySuppression, logger);
  const guard = new GraphGuardImpl();
  const edgeResolver = new EdgeResolverImpl(logger);

  return {
    nodeExecutor: executor,
    edgeResolver,
    graphScheduler: scheduler,
    graphGuard: guard,
    predicateRegistry,
    logger,
  };
}

// ============================================================================
// L1. 正常状态流转
// ============================================================================

test("L1. 正常生命周期：idle → ready → running → completed → idle", async () => {
  const manager = new GraphLifecycleManager();
  assert.equal(manager.status(), "idle", "初始状态应为 idle");

  const graph = makeLinearGraph("g-l1");
  const options = makeOrchestratorOptions(makeSuccessExecutor());

  await manager.initialize(graph, options);
  assert.equal(manager.status(), "ready", "initialize 后应为 ready");

  const report = await manager.start();
  assert.equal(manager.status(), "completed", "start 完成后应为 completed");
  assert.equal(report.finalStatus, "completed", "图执行最终状态应为 completed");

  await manager.reset();
  assert.equal(manager.status(), "idle", "reset 后应为 idle");
});

// ============================================================================
// L2. 非法状态转换：start() 在 idle / running 状态报错
// ============================================================================

test("L2. start() 在 idle 状态应抛出错误", async () => {
  const manager = new GraphLifecycleManager();
  assert.equal(manager.status(), "idle");

  await assert.rejects(
    async () => manager.start(),
    /只能在 ready 状态.*调用 start/,
    "idle 状态调用 start() 应抛出非法状态转换错误"
  );
});

test("L2b. start() 在 running 状态应抛出错误", async () => {
  const manager = new GraphLifecycleManager();
  const graph = makeLinearGraph("g-l2b");
  const options = makeOrchestratorOptions(makeSuccessExecutor());

  await manager.initialize(graph, options);

  // 启动 start() 但不 await，立即再次调用 start() 应报错
  const startPromise = manager.start();
  assert.equal(manager.status(), "running");

  await assert.rejects(
    async () => manager.start(),
    /只能在 ready 状态.*调用 start/,
    "running 状态调用 start() 应抛出非法状态转换错误"
  );

  await startPromise;
  await manager.reset();
});

// ============================================================================
// L3. 非法状态转换：initialize() 在 running / stopping / resetting 状态报错
// ============================================================================

test("L3. initialize() 在 running 状态应抛出错误", async () => {
  const manager = new GraphLifecycleManager();
  const graph = makeLinearGraph("g-l3");
  const options = makeOrchestratorOptions(makeSuccessExecutor());

  await manager.initialize(graph, options);
  const startPromise = manager.start();

  await assert.rejects(
    async () => manager.initialize(makeLinearGraph("g-l3-illegal"), options),
    /只能从 idle \/ completed \/ failed 状态调用 initialize/,
    "running 状态调用 initialize() 应抛出非法状态转换错误"
  );

  await startPromise;
  await manager.reset();
});

// ============================================================================
// L4. reset() 在 running / stopping 状态报错
// ============================================================================

test("L4. reset() 在 running 状态应抛出错误", async () => {
  const manager = new GraphLifecycleManager();
  const graph = makeLinearGraph("g-l4");
  const options = makeOrchestratorOptions(makeSuccessExecutor());

  await manager.initialize(graph, options);
  const startPromise = manager.start();

  await assert.rejects(
    async () => manager.reset(),
    /无法在 running 状态下重置/,
    "running 状态调用 reset() 应抛出非法状态转换错误"
  );

  await startPromise;
  await manager.reset();
});

// ============================================================================
// L5. stop() 后状态迁移到 stopping，start() Promise 完成后进入 failed
// ============================================================================

test("L5. stop() 触发 stopping，最终状态由 start() Promise 完成时设置为 failed", async () => {
  const manager = new GraphLifecycleManager();
  const graph = makeLinearGraph("g-l5");
  const options = makeOrchestratorOptions(makeSlowExecutor("start", 500));

  await manager.initialize(graph, options);

  const startPromise = manager.start();

  // 等待进入 running 状态
  await new Promise<void>((resolve) => {
    const check = () => {
      if (manager.status() === "running") {
        resolve();
      } else {
        setTimeout(check, 5);
      }
    };
    check();
  });

  await manager.stop("测试停止");
  assert.equal(manager.status(), "stopping", "stop() 后应为 stopping");

  const report = await startPromise;
  assert.equal(manager.status(), "failed", "start() Promise 完成后应为 failed");
  assert.notEqual(report.finalStatus, "completed", "中止后最终状态不应为 completed");

  await manager.reset();
});

// ============================================================================
// L6. 状态变更监听器按顺序触发
// ============================================================================

test("L6. 状态变更监听器按顺序触发并携带正确事件", async () => {
  const manager = new GraphLifecycleManager();
  const events: GraphLifecycleStateChangeEvent[] = [];
  manager.onStateChange = (event) => {
    events.push(event);
  };

  const graph = makeLinearGraph("g-l6");
  const options = makeOrchestratorOptions(makeSuccessExecutor());

  await manager.initialize(graph, options);
  await manager.start();
  await manager.reset();

  assert.equal(events.length, 6, "应触发 6 次状态变更事件");

  const expectedTransitions: Array<[GraphLifecycleState, GraphLifecycleState]> = [
    ["idle", "initializing"],
    ["initializing", "ready"],
    ["ready", "running"],
    ["running", "completed"],
    ["completed", "resetting"],
    ["resetting", "idle"],
  ];

  for (let i = 0; i < expectedTransitions.length; i++) {
    const [oldState, newState] = expectedTransitions[i];
    assert.equal(events[i].oldState, oldState, `第 ${i + 1} 次事件 oldState 应为 ${oldState}`);
    assert.equal(events[i].newState, newState, `第 ${i + 1} 次事件 newState 应为 ${newState}`);
    assert.ok(events[i].changedAt, `第 ${i + 1} 次事件应携带 changedAt`);
  }
});

// ============================================================================
// L7. 监听器异常不中断状态转换
// ============================================================================

test("L7. 状态变更监听器抛异常不中断状态转换", async () => {
  const manager = new GraphLifecycleManager();
  let callCount = 0;
  manager.onStateChange = () => {
    callCount++;
    if (callCount === 2) {
      throw new Error("监听器模拟异常");
    }
  };

  const graph = makeLinearGraph("g-l7");
  const options = makeOrchestratorOptions(makeSuccessExecutor());

  // 不应抛出异常
  await manager.initialize(graph, options);
  await manager.start();
  await manager.reset();

  assert.equal(manager.status(), "idle", "监听器异常不应影响最终状态");
  assert.equal(callCount, 6, "所有状态变更事件仍应触发监听器");
});

// ============================================================================
// L8. 多次 initialize / start / reset 循环
// ============================================================================

test("L8. 同一管理器实例可重复 initialize → start → reset", async () => {
  const manager = new GraphLifecycleManager();

  for (let i = 0; i < 3; i++) {
    const graph = makeLinearGraph(`g-l8-${i}`);
    const options = makeOrchestratorOptions(makeSuccessExecutor());

    await manager.initialize(graph, options);
    assert.equal(manager.status(), "ready");

    const report = await manager.start();
    assert.equal(report.finalStatus, "completed");
    assert.equal(manager.status(), "completed");

    await manager.reset();
    assert.equal(manager.status(), "idle");
  }
});

// ============================================================================
// L9. start() 内部节点执行异常时状态进入 failed
// ============================================================================

test("L9. start() 内部节点执行异常时状态进入 failed", async () => {
  const manager = new GraphLifecycleManager();
  const graph = makeLinearGraph("g-l9");
  const options = makeOrchestratorOptions(makeThrowingExecutor("start"));

  await manager.initialize(graph, options);
  assert.equal(manager.status(), "ready");

  // GraphLoopOrchestrator 会捕获节点执行异常并构造 failed 结果，
  // 因此 manager.start() 不会向上抛异常，而是返回 finalStatus !== "completed" 的报告。
  const report = await manager.start();
  assert.notEqual(report.finalStatus, "completed", "节点执行异常应导致最终状态非 completed");
  assert.equal(manager.status(), "failed", "start() 异常后状态应为 failed");

  // failed 状态下允许 reset
  await manager.reset();
  assert.equal(manager.status(), "idle");
});
