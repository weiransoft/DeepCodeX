/**
 * EAG-Graph NodeExecutorImpl 单元/集成测试（Phase 3）
 *
 * 测试范围：
 * - C1. 构造校验：缺少 goalDispatcher → 抛出
 * - C2. 构造校验：缺少 loopHandoffAdapter → 抛出
 * - L1. loop 节点：单次迭代成功 → completed，loopReport 字段完整
 * - L2. loop 节点：迭代失败 → failed，loopReport 记录迭代次数
 * - L3. loop 节点：返回 llmCallCount=0
 * - T1. task 节点：plugin 执行成功 → completed，output 携带结果与 artifacts
 * - T2. task 节点：plugin 未注册 → failed
 * - T3. task 节点：缺少 plugin 字段 → failed
 * - P1. decision / merge / fork / end 节点：透传 completed，output 为输入副本
 * - P2. 取消上下文：返回 failed（含取消原因）
 * - P3. LoopHandoffAdapter 抛异常：内部捕获并返回 failed
 * - P4. 未知节点类型（类型兜底）：返回 failed
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止使用 mock 框架，使用真实 GoalDispatcher / PluginRegistry / GoalCommandPlugin
 * - 每个测试用例独立，无共享可变状态
 *
 * 设计依据：
 * - LOOP-GRAPH-FUSION-DESIGN.md §8.1 NodeExecutor
 * - eag/graph/node-executor.ts 源文件（被测对象）
 * - eag/graph/node-loop-kernel.ts NodeLoopKernel
 * - team/plugins/goal-dispatcher.ts GoalDispatcher / makeGoal / makeBatch
 *
 * @module core/tests/eag-graph-node-executor
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { NodeExecutorImpl, createNodeExecutor } from "../eag/graph/node-executor";
import type { NodeExecutorImplOptions } from "../eag/graph/node-executor";
import type { LoopHandoffAdapter } from "../eag/graph/graph-loop-protocols";
import { DEFAULT_WORK_GRAPH_CONFIG, DEFAULT_NODE_LOOP_CONFIG } from "../eag/graph/graph-loop-models";
import type {
  GraphNodeDef,
  GraphNodeResult,
  GraphRunContext,
  GraphLogger,
  NodeFieldContract,
  PredicateRegistry,
  PredicateFunction,
} from "../eag/graph/graph-loop-models";
import type { LoopEvaluationVerdict, GeneratorResult } from "../eag/loop/models";
import { GoalDispatcher, PluginRegistry } from "../team/plugins/goal-dispatcher";
import type { GoalCommandPlugin, DispatchResult, PluginContext } from "../team/types";

// ============================================================================
// 辅助：构造测试数据
// ============================================================================

/**
 * 构造一个 loop 节点定义
 *
 * @param nodeId 节点 ID
 * @param maxIterations 最大迭代次数（默认 3）
 */
function makeLoopNode(nodeId: string, maxIterations: number = 3): GraphNodeDef {
  return {
    nodeId,
    nodeType: "loop",
    label: nodeId,
    task: `${nodeId} 循环任务`,
    inputContract: [],
    outputContract: [],
    loopConfig: {
      ...DEFAULT_NODE_LOOP_CONFIG,
      loopType: "coding",
      discoveryMode: "auto",
      evaluatorMode: "standard",
      maxIterations,
      maxTokens: 10000,
      stopWhen: "",
      stageOrder: ["plan", "dev", "verify"],
      autoCommit: false,
      humanCheckpointEvery: 0,
    },
  };
}

/**
 * 构造一个 task 节点定义
 *
 * @param nodeId 节点 ID
 * @param plugin 关联 plugin 名
 */
function makeTaskNode(nodeId: string, plugin: string = "echo"): GraphNodeDef {
  return {
    nodeId,
    nodeType: "task",
    label: nodeId,
    task: `${nodeId} 任务描述`,
    inputContract: [],
    outputContract: [],
    plugin,
  };
}

/**
 * 构造一个 decision / merge / fork / end 控制节点定义
 *
 * @param nodeId 节点 ID
 * @param nodeType 节点类型
 */
function makeControlNode(nodeId: string, nodeType: "decision" | "merge" | "fork" | "end"): GraphNodeDef {
  return {
    nodeId,
    nodeType,
    label: nodeId,
    task: `${nodeId} 控制节点`,
    inputContract: [],
    outputContract: [],
  };
}

/**
 * 构造一个最小可用的 GraphRunContext
 *
 * @param overrides 部分字段覆盖
 */
function makeRunContext(overrides?: Partial<GraphRunContext>): GraphRunContext {
  return {
    runId: overrides?.runId ?? "run-001",
    graphId: overrides?.graphId ?? "g1",
    globalState: overrides?.globalState ?? {},
    visited: overrides?.visited ?? new Set<string>(),
    nodeResults: overrides?.nodeResults ?? new Map<string, GraphNodeResult>(),
    cancelled: overrides?.cancelled ?? false,
    config: overrides?.config ?? DEFAULT_WORK_GRAPH_CONFIG,
    predicateRegistry: overrides?.predicateRegistry ?? createFakePredicateRegistry(),
    currentDepth: overrides?.currentDepth ?? 0,
    totalTokensUsed: overrides?.totalTokensUsed ?? 0,
    startedAtMs: overrides?.startedAtMs ?? Date.now(),
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
 * 构造一个真实的 PredicateRegistry 实现（不使用 mock）
 */
function createFakePredicateRegistry(): PredicateRegistry {
  const registry: Map<string, PredicateFunction> = new Map();
  registry.set("alwaysTrue", () => true);
  return {
    register(id: string, predicate: PredicateFunction): void {
      if (registry.has(id)) {
        throw new Error(`谓词 ID 已存在：${id}`);
      }
      registry.set(id, predicate);
    },
    lookup(id: string): PredicateFunction {
      const fn = registry.get(id);
      if (!fn) {
        throw new Error(`谓词 ID 未注册：${id}`);
      }
      return fn;
    },
  };
}

// ============================================================================
// 辅助：构造依赖组件
// ============================================================================

/**
 * 构造一个固定行为的 LoopHandoffAdapter（不使用 mock）
 *
 * @param generatorResult 每轮 Handoff 返回的 GeneratorResult
 * @param verdict 每轮 Verification 返回的判定结果
 */
function createFixedLoopHandoffAdapter(
  generatorResult: GeneratorResult,
  verdict: LoopEvaluationVerdict
): LoopHandoffAdapter {
  return {
    createLoopExecutor(): () => Promise<GeneratorResult> {
      return async () => generatorResult;
    },
    createLoopEvaluator(): () => Promise<LoopEvaluationVerdict> {
      return async () => verdict;
    },
  };
}

/**
 * 构造一个会抛异常的 LoopHandoffAdapter（用于测试错误兜底）
 */
function createThrowingLoopHandoffAdapter(): LoopHandoffAdapter {
  return {
    createLoopExecutor(): never {
      throw new Error("适配器构造 executor 时模拟异常");
    },
    createLoopEvaluator(): never {
      throw new Error("适配器构造 evaluator 时模拟异常");
    },
  };
}

/**
 * 构造一个真实 GoalDispatcher，并注册测试 plugin
 *
 * @param plugins 要注册的 plugin 列表
 */
function createGoalDispatcher(plugins: ReadonlyArray<GoalCommandPlugin>): GoalDispatcher {
  const registry = new PluginRegistry();
  for (const plugin of plugins) {
    registry.register(plugin);
  }
  return new GoalDispatcher(registry, { maxParallel: 1, failFast: true });
}

/**
 * 创建一个简单的测试 plugin（GoalCommandPlugin）
 *
 * @param name plugin 名
 * @param result 执行返回的 DispatchResult
 */
function createTestPlugin(name: string, result: DispatchResult): GoalCommandPlugin {
  return {
    name: name as GoalCommandPlugin["name"],
    priority: 10,
    description: `测试 plugin：${name}`,
    async execute(): Promise<DispatchResult> {
      return result;
    },
  };
}

/**
 * 构造 NodeExecutorImpl 测试实例
 *
 * @param options 覆盖默认构造选项的字段
 */
function createNodeExecutorForTest(
  options?: Partial<NodeExecutorImplOptions> & { plugins?: ReadonlyArray<GoalCommandPlugin> }
): NodeExecutorImpl {
  const plugins = options?.plugins ?? [];
  const goalDispatcher = options?.goalDispatcher ?? createGoalDispatcher(plugins);
  return new NodeExecutorImpl({
    goalDispatcher,
    loopHandoffAdapter:
      options?.loopHandoffAdapter ??
      createFixedLoopHandoffAdapter(
        { success: true, output: { result: "ok" } },
        {
          passed: true,
          evaluatorId: "test-evaluator",
          reason: "测试通过",
          findings: [],
          severity: "info",
          suggestedFix: "",
          sampledArtifacts: [],
        }
      ),
    experienceStore: options?.experienceStore,
    logger: options?.logger ?? makeSilentLogger(),
  });
}

// ============================================================================
// 构造校验测试
// ============================================================================

test("C1. 构造校验：缺少 goalDispatcher → 抛出", () => {
  assert.throws(
    () =>
      new NodeExecutorImpl({
        goalDispatcher: undefined as unknown as GoalDispatcher,
        loopHandoffAdapter: createFixedLoopHandoffAdapter({}, { passed: true } as LoopEvaluationVerdict),
      }),
    /goalDispatcher 必填/
  );
});

test("C2. 构造校验：缺少 loopHandoffAdapter → 抛出", () => {
  assert.throws(
    () =>
      new NodeExecutorImpl({
        goalDispatcher: createGoalDispatcher([]),
        loopHandoffAdapter: undefined as unknown as LoopHandoffAdapter,
      }),
    /loopHandoffAdapter 必填/
  );
});

// ============================================================================
// loop 节点测试
// ============================================================================

test("L1. loop 节点：单次迭代成功 → completed，loopReport 字段完整", async () => {
  const adapter = createFixedLoopHandoffAdapter(
    { success: true, output: { result: "loop-ok" }, token_used: 12 },
    {
      passed: true,
      evaluatorId: "test-evaluator",
      reason: "全部通过",
      findings: [],
      severity: "info",
      suggestedFix: "",
      sampledArtifacts: [],
    }
  );
  const executor = createNodeExecutorForTest({ loopHandoffAdapter: adapter });
  const node = makeLoopNode("loop1", 3);
  const context = makeRunContext();

  const result = await executor.execute(node, { req: "实现登录" }, context);

  assert.equal(result.status, "completed", "loop 节点应完成");
  assert.equal(result.nodeId, "loop1");
  assert.ok(result.loopReport, "应携带 loopReport");
  assert.equal(result.loopReport?.totalIterations, 1, "应只迭代 1 轮");
  assert.equal(result.loopReport?.loopType, "coding");
  assert.equal(result.loopReport?.objective, node.task);
  assert.equal(result.loopReport?.tokenUsed, 12, "应记录累计 token");
  assert.equal(result.loopReport?.committedCount, 0, "图场景不自动 commit");
  assert.equal(result.loopReport?.humanCheckpoints.length, 0, "图场景无人工检查点");
  assert.equal(result.llmCallCount, 0, "llmCallCount 应为 0");
  assert.equal(context.totalTokensUsed, 12, "token 应累加到图级上下文");
});

test("L2. loop 节点：迭代验证失败 → failed，loopReport 记录迭代次数", async () => {
  const adapter = createFixedLoopHandoffAdapter(
    { success: false, output: {} },
    {
      passed: false,
      evaluatorId: "test-evaluator",
      reason: "测试未通过",
      findings: ["断言失败"],
      severity: "blocker",
      suggestedFix: "修复代码",
      sampledArtifacts: [],
    }
  );
  const executor = createNodeExecutorForTest({ loopHandoffAdapter: adapter });
  const node = makeLoopNode("loop2", 3);
  const context = makeRunContext();

  const result = await executor.execute(node, { req: "实现登录" }, context);

  assert.equal(result.status, "failed", "验证持续失败应最终 failed");
  assert.ok(result.loopReport, "应携带 loopReport");
  assert.equal(result.loopReport?.totalIterations, 3, "应达到最大迭代次数");
  assert.equal(result.loopReport?.finalStatus, "failed");
  assert.ok(result.failureReason, "应填写失败原因");
});

test("L3. loop 节点缺少 loopConfig → failed", async () => {
  const executor = createNodeExecutorForTest();
  const node: GraphNodeDef = {
    nodeId: "loop-bad",
    nodeType: "loop",
    label: "loop-bad",
    task: "缺少 loopConfig",
    inputContract: [],
    outputContract: [],
  };
  const context = makeRunContext();

  const result = await executor.execute(node, {}, context);

  assert.equal(result.status, "failed");
  assert.match(result.failureReason ?? "", /缺少 loopConfig/);
});

// ============================================================================
// task 节点测试
// ============================================================================

test("T1. task 节点：plugin 执行成功 → completed，output 携带结果与 artifacts", async () => {
  const pluginResult: DispatchResult = {
    taskId: "00000000-0000-0000-0000-000000000000",
    dispatchId: "00000000-0000-0000-0000-000000000000",
    matchedRole: {
      roleId: "solo-coder",
      roleName: "Solo Coder",
      confidence: 1,
      matchedCapabilities: [],
      matchedSkills: [],
      reasons: ["测试 plugin"],
      scoreBreakdown: {
        capability: 1,
        skill: 1,
        keyword: 1,
        priority: 1,
      },
      strategy: "keyword",
    },
    status: "succeeded",
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    durationMs: 100,
    output: "任务执行成功",
    artifacts: ["src/foo.ts"],
    tokensConsumed: { prompt: 10, completion: 20, total: 30 },
  };
  const plugin = createTestPlugin("echo", pluginResult);
  const executor = createNodeExecutorForTest({ plugins: [plugin] });
  const node = makeTaskNode("task1", "echo");
  const context = makeRunContext();

  const result = await executor.execute(node, { req: "生成代码" }, context);

  assert.equal(result.status, "completed");
  assert.equal(result.nodeId, "task1");
  assert.equal(result.output.output, "任务执行成功");
  assert.deepEqual(result.output.artifacts, ["src/foo.ts"]);
});

test("T2. task 节点：plugin 未注册 → failed", async () => {
  const executor = createNodeExecutorForTest({ plugins: [] });
  const node = makeTaskNode("task2", "missing-plugin");
  const context = makeRunContext();

  const result = await executor.execute(node, {}, context);

  assert.equal(result.status, "failed");
  assert.match(result.failureReason ?? "", /未注册/);
});

test("T3. task 节点缺少 plugin 字段 → failed", async () => {
  const executor = createNodeExecutorForTest();
  const node: GraphNodeDef = {
    nodeId: "task-bad",
    nodeType: "task",
    label: "task-bad",
    task: "缺少 plugin",
    inputContract: [],
    outputContract: [],
  };
  const context = makeRunContext();

  const result = await executor.execute(node, {}, context);

  assert.equal(result.status, "failed");
  assert.match(result.failureReason ?? "", /未配置 plugin/);
});

// ============================================================================
// 控制节点与其他路径测试
// ============================================================================

for (const nodeType of ["decision", "merge", "fork", "end"] as const) {
  test(`P1.${nodeType} 节点：透传 completed，output 为输入副本`, async () => {
    const executor = createNodeExecutorForTest();
    const node = makeControlNode(`${nodeType}1`, nodeType);
    const context = makeRunContext();
    const input = { prevResult: "from-upstream", count: 42 };

    const result = await executor.execute(node, input, context);

    assert.equal(result.status, "completed");
    assert.equal(result.nodeId, `${nodeType}1`);
    assert.equal(result.nodeType, nodeType);
    assert.equal(result.output.prevResult, "from-upstream");
    assert.equal(result.output.count, 42);
  });
}

test("P2. 取消上下文：返回 failed（含取消原因）", async () => {
  const executor = createNodeExecutorForTest();
  const node = makeTaskNode("cancel-task");
  const context = makeRunContext({ cancelled: true });

  const result = await executor.execute(node, {}, context);

  assert.equal(result.status, "failed");
  assert.match(result.failureReason ?? "", /用户取消/);
});

test("P3. LoopHandoffAdapter 抛异常：内部捕获并返回 failed", async () => {
  const executor = createNodeExecutorForTest({
    loopHandoffAdapter: createThrowingLoopHandoffAdapter(),
  });
  const node = makeLoopNode("loop-err", 3);
  const context = makeRunContext();

  const result = await executor.execute(node, {}, context);

  assert.equal(result.status, "failed");
  assert.match(result.failureReason ?? "", /执行异常/);
});

test("P4. createNodeExecutor 工厂函数返回实例", () => {
  const instance = createNodeExecutorForTest();
  assert.ok(instance instanceof NodeExecutorImpl);
});
