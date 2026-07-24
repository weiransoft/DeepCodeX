/**
 * EAG-Graph NodeLoopKernel 单元测试（Phase 2）
 *
 * 测试范围：
 * - N1. 构造校验：loop 节点缺少 loopConfig → 抛出
 * - N2. 构造校验：inputContract 必填字段缺失 → 抛出
 * - N3. 五步闭环：首轮成功（verdict.passed=true → stop_success → completed）
 * - N4. 五步闭环：修复后成功（首轮失败 → fix → 第二轮成功 → completed）
 * - N5. 五步闭环：连续失败到 stop_failure（连续失败 >= 5 → failed）
 * - N6. 五步闭环：达到最大迭代次数且最后一轮通过 → completed
 * - N7. 五步闭环：达到最大迭代次数且最后一轮未通过 → failed
 * - N8. 五步闭环：用户取消 → failed（failureReason 含"用户取消"）
 * - N9. 五步闭环：outputContract 校验失败 → 降级为 failed
 * - N10. 五步闭环：executor 抛出异常 → failed
 * - N11. getEvents() 返回事件序列
 * - N12. getCumulativeTokens() 累计 token
 * - N13. token 累加到 context.totalTokensUsed
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止使用 mock 框架，使用真实函数实现 executor/evaluator 回调
 * - 每个测试用例独立，无共享可变状态
 *
 * 设计依据：
 * - LOOP-GRAPH-FUSION-DESIGN.md §10 NodeLoopKernel（方案 C）
 * - eag/graph/node-loop-kernel.ts 源文件（被测对象）
 * - eag/loop/scheduler.ts LoopScheduler.decideNext() 决策逻辑
 *
 * @module core/tests/eag-graph-node-loop-kernel
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { NodeLoopKernel } from "../eag/graph/node-loop-kernel";
import type { NodeLoopKernelOptions, LoopExecutorCallback, LoopEvaluatorCallback } from "../eag/graph/node-loop-kernel";
import { DEFAULT_WORK_GRAPH_CONFIG, DEFAULT_NODE_LOOP_CONFIG } from "../eag/graph/graph-loop-models";
import type {
  GraphNodeDef,
  GraphRunContext,
  GraphNodeResult,
  NodeFieldContract,
  PredicateRegistry,
  PredicateFunction,
} from "../eag/graph/graph-loop-models";
import type { LoopEvaluationVerdict, GeneratorResult } from "../eag/loop/models";

// ============================================================================
// 辅助：构造测试数据
// ============================================================================

/**
 * 构造一个 loop 节点定义
 *
 * @param nodeId 节点 ID
 * @param inputContract 输入契约
 * @param outputContract 输出契约
 * @param maxIterations 最大迭代次数（默认 10）
 */
function makeLoopNode(
  nodeId: string,
  inputContract: NodeFieldContract[] = [],
  outputContract: NodeFieldContract[] = [],
  maxIterations: number = 10
): GraphNodeDef {
  return {
    nodeId,
    nodeType: "loop",
    label: nodeId,
    task: `${nodeId} 循环任务`,
    inputContract,
    outputContract,
    loopConfig: {
      ...DEFAULT_NODE_LOOP_CONFIG,
      maxIterations,
      maxTokens: 100_000,
    },
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
    has(id: string): boolean {
      return registry.has(id);
    },
  };
}

/**
 * 构造一个 passed 的验证判定
 *
 * @param evaluatorId Evaluator ID
 */
function makePassedVerdict(evaluatorId: string = "test-evaluator"): LoopEvaluationVerdict {
  return {
    passed: true,
    evaluatorId,
    reason: "所有检查通过",
    findings: [],
    severity: "info",
    suggestedFix: "",
    sampledArtifacts: [],
  };
}

/**
 * 构造一个 failed 的验证判定
 *
 * @param evaluatorId Evaluator ID
 * @param reason 失败原因
 */
function makeFailedVerdict(
  evaluatorId: string = "test-evaluator",
  reason: string = "存在未通过的检查"
): LoopEvaluationVerdict {
  return {
    passed: false,
    evaluatorId,
    reason,
    findings: ["测试失败：assertion error"],
    severity: "blocker",
    suggestedFix: "请修复失败的测试",
    sampledArtifacts: [],
  };
}

/**
 * 构造一个含 output 字段的 GeneratorResult
 *
 * @param output 输出数据
 * @param tokenUsed 使用的 token 数
 */
function makeGeneratorResult(output: Record<string, unknown>, tokenUsed: number = 0): GeneratorResult {
  return {
    success: true,
    output,
    token_used: tokenUsed,
  };
}

/**
 * 构造一个静默的 logger（不输出日志，避免测试输出噪音）
 */
function makeSilentLogger() {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

// ============================================================================
// N1. 构造校验：loop 节点缺少 loopConfig → 抛出
// ============================================================================

test("N1. NodeLoopKernel 构造时 loop 节点缺少 loopConfig 抛出", () => {
  const node: GraphNodeDef = {
    nodeId: "loop1",
    nodeType: "loop",
    label: "循环节点",
    task: "循环任务",
    inputContract: [],
    outputContract: [],
    // 缺少 loopConfig
  };
  const context = makeRunContext();

  assert.throws(
    () =>
      new NodeLoopKernel({
        node,
        input: {},
        context,
        executor: async () => ({}),
        evaluator: async () => makePassedVerdict(),
      }),
    /缺少 loopConfig/,
    "loop 节点缺少 loopConfig 时应抛出"
  );
});

// ============================================================================
// N2. 构造校验：inputContract 必填字段缺失 → 抛出
// ============================================================================

test("N2. NodeLoopKernel 构造时必填输入字段缺失抛出", () => {
  const node = makeLoopNode("loop1", [{ name: "requirement", type: "string", required: true }]);
  const context = makeRunContext();

  // input 中缺少 requirement 字段
  assert.throws(
    () =>
      new NodeLoopKernel({
        node,
        input: {},
        context,
        executor: async () => ({}),
        evaluator: async () => makePassedVerdict(),
      }),
    /必填输入字段 "requirement" 缺失/,
    "必填输入字段缺失时应抛出"
  );
});

// ============================================================================
// N3. 五步闭环：首轮成功
// ============================================================================

test("N3. 首轮验证通过时返回 completed", async () => {
  const node = makeLoopNode("loop1");
  const context = makeRunContext();

  // executor 总是返回成功结果
  const executor: LoopExecutorCallback = async () => {
    return makeGeneratorResult({ result: "完成" });
  };
  // evaluator 总是返回 passed
  const evaluator: LoopEvaluatorCallback = async () => {
    return makePassedVerdict();
  };

  const kernel = new NodeLoopKernel({
    node,
    input: {},
    context,
    executor,
    evaluator,
    logger: makeSilentLogger(),
  });

  const result = await kernel.run();

  assert.equal(result.status, "completed", "首轮通过时应为 completed");
  assert.equal(result.nodeId, "loop1");
  assert.equal(result.failureReason, undefined, "completed 时不应有 failureReason");
  assert.equal(result.output.result, "完成", "应提取 generatorResult.output");
});

// ============================================================================
// N4. 五步闭环：修复后成功
// ============================================================================

test("N4. 首轮失败第二轮成功时返回 completed", async () => {
  const node = makeLoopNode("loop1", [], [], 10);
  const context = makeRunContext();

  // 记录调用次数
  let executorCallCount = 0;
  let evaluatorCallCount = 0;

  // executor 总是返回成功结果
  const executor: LoopExecutorCallback = async (iteration) => {
    executorCallCount++;
    return makeGeneratorResult({ result: `第${iteration}轮结果` });
  };
  // evaluator 首轮失败，第二轮通过
  const evaluator: LoopEvaluatorCallback = async (iteration) => {
    evaluatorCallCount++;
    if (iteration === 1) {
      return makeFailedVerdict("test-evaluator", "首轮测试未通过");
    }
    return makePassedVerdict();
  };

  const kernel = new NodeLoopKernel({
    node,
    input: {},
    context,
    executor,
    evaluator,
    logger: makeSilentLogger(),
  });

  const result = await kernel.run();

  assert.equal(result.status, "completed", "修复后成功应为 completed");
  assert.equal(executorCallCount, 2, "executor 应被调用 2 次");
  assert.equal(evaluatorCallCount, 2, "evaluator 应被调用 2 次");
  assert.equal(result.output.result, "第2轮结果", "应使用最后一轮的输出");
});

// ============================================================================
// N5. 五步闭环：连续失败到 stop_failure
// ============================================================================

test("N5. 连续失败 5 次以上时返回 failed（stop_failure）", async () => {
  // maxIterations 设为 10，连续失败 5 次后 LoopScheduler 应返回 stop_failure
  const node = makeLoopNode("loop1", [], [], 10);
  const context = makeRunContext();

  let evaluatorCallCount = 0;

  const executor: LoopExecutorCallback = async (iteration) => {
    return makeGeneratorResult({ result: `第${iteration}轮结果` });
  };
  // evaluator 总是返回失败
  const evaluator: LoopEvaluatorCallback = async () => {
    evaluatorCallCount++;
    return makeFailedVerdict("test-evaluator", "测试持续失败");
  };

  const kernel = new NodeLoopKernel({
    node,
    input: {},
    context,
    executor,
    evaluator,
    logger: makeSilentLogger(),
  });

  const result = await kernel.run();

  assert.equal(result.status, "failed", "连续失败后应为 failed");
  assert.ok(evaluatorCallCount >= 5, `evaluator 应被调用至少 5 次，实际 ${evaluatorCallCount} 次`);
  assert.ok(result.failureReason, "failed 时应有 failureReason");
});

// ============================================================================
// N6. 五步闭环：达到最大迭代次数且最后一轮通过 → completed
// ============================================================================

test("N6. 达到最大迭代次数且最后一轮通过时返回 completed", async () => {
  // maxIterations 设为 2
  const node = makeLoopNode("loop1", [], [], 2);
  const context = makeRunContext();

  let evaluatorCallCount = 0;

  const executor: LoopExecutorCallback = async (iteration) => {
    return makeGeneratorResult({ result: `第${iteration}轮结果` });
  };
  // evaluator 第一轮失败，第二轮通过（达到 maxIterations=2 且最后一轮通过 → stop_success）
  const evaluator: LoopEvaluatorCallback = async () => {
    evaluatorCallCount++;
    if (evaluatorCallCount === 1) {
      return makeFailedVerdict();
    }
    return makePassedVerdict();
  };

  const kernel = new NodeLoopKernel({
    node,
    input: {},
    context,
    executor,
    evaluator,
    logger: makeSilentLogger(),
  });

  const result = await kernel.run();

  assert.equal(result.status, "completed", "达到 maxIterations 且最后一轮通过应为 completed");
  assert.equal(evaluatorCallCount, 2, "evaluator 应被调用 2 次（maxIterations=2）");
});

// ============================================================================
// N7. 五步闭环：达到最大迭代次数且最后一轮未通过 → failed
// ============================================================================

test("N7. 达到最大迭代次数且最后一轮未通过时返回 failed", async () => {
  // maxIterations 设为 2，连续失败不会先达到 5 次（2 < 5）
  const node = makeLoopNode("loop1", [], [], 2);
  const context = makeRunContext();

  const executor: LoopExecutorCallback = async (iteration) => {
    return makeGeneratorResult({ result: `第${iteration}轮结果` });
  };
  // evaluator 总是返回失败
  const evaluator: LoopEvaluatorCallback = async () => {
    return makeFailedVerdict();
  };

  const kernel = new NodeLoopKernel({
    node,
    input: {},
    context,
    executor,
    evaluator,
    logger: makeSilentLogger(),
  });

  const result = await kernel.run();

  assert.equal(result.status, "failed", "达到 maxIterations 且最后一轮未通过应为 failed");
  assert.ok(result.failureReason, "应有 failureReason");
  assert.match(result.failureReason!, /最大迭代次数|未通过/);
});

// ============================================================================
// N8. 五步闭环：用户取消 → failed
// ============================================================================

test("N8. 用户取消时返回 failed 且 failureReason 含'用户取消'", async () => {
  const node = makeLoopNode("loop1", [], [], 10);
  // 构造一个已取消的 context
  const context = makeRunContext({ cancelled: true });

  const executor: LoopExecutorCallback = async () => {
    return makeGeneratorResult({ result: "结果" });
  };
  const evaluator: LoopEvaluatorCallback = async () => {
    return makePassedVerdict();
  };

  const kernel = new NodeLoopKernel({
    node,
    input: {},
    context,
    executor,
    evaluator,
    logger: makeSilentLogger(),
  });

  const result = await kernel.run();

  assert.equal(result.status, "failed", "用户取消时应为 failed");
  assert.ok(result.failureReason, "应有 failureReason");
  assert.match(result.failureReason!, /用户取消/);
});

// ============================================================================
// N9. 五步闭环：outputContract 校验失败 → 降级为 failed
// ============================================================================

test("N9. 首轮通过但 outputContract 校验失败时降级为 failed", async () => {
  // outputContract 要求 result 字段为 string 类型
  const node = makeLoopNode("loop1", [], [{ name: "result", type: "string", required: true }], 10);
  const context = makeRunContext();

  // executor 返回的 output 中 result 是 number（不符合 string 契约）
  const executor: LoopExecutorCallback = async () => {
    return makeGeneratorResult({ result: 12345 }); // number 而非 string
  };
  const evaluator: LoopEvaluatorCallback = async () => {
    return makePassedVerdict();
  };

  const kernel = new NodeLoopKernel({
    node,
    input: {},
    context,
    executor,
    evaluator,
    logger: makeSilentLogger(),
  });

  const result = await kernel.run();

  assert.equal(result.status, "failed", "outputContract 校验失败应降级为 failed");
  assert.ok(result.failureReason, "应有 failureReason");
  assert.match(result.failureReason!, /result|类型不匹配|缺失/);
});

// ============================================================================
// N10. 五步闭环：executor 抛出异常 → failed
// ============================================================================

test("N10. executor 抛出异常时返回 failed", async () => {
  const node = makeLoopNode("loop1", [], [], 10);
  const context = makeRunContext();

  const executor: LoopExecutorCallback = async () => {
    throw new Error("executor 执行失败：LLM 调用超时");
  };
  const evaluator: LoopEvaluatorCallback = async () => {
    return makePassedVerdict();
  };

  const kernel = new NodeLoopKernel({
    node,
    input: {},
    context,
    executor,
    evaluator,
    logger: makeSilentLogger(),
  });

  const result = await kernel.run();

  assert.equal(result.status, "failed", "executor 抛出异常时应为 failed");
  assert.ok(result.failureReason, "应有 failureReason");
  assert.match(result.failureReason!, /Loop 执行异常/);
});

// ============================================================================
// N11. getEvents() 返回事件序列
// ============================================================================

test("N11. getEvents() 返回五步闭环产生的事件序列", async () => {
  const node = makeLoopNode("loop1", [], [], 10);
  const context = makeRunContext();

  let evaluatorCallCount = 0;
  const executor: LoopExecutorCallback = async (iteration) => {
    return makeGeneratorResult({ result: `第${iteration}轮` });
  };
  const evaluator: LoopEvaluatorCallback = async () => {
    evaluatorCallCount++;
    if (evaluatorCallCount === 1) {
      return makeFailedVerdict();
    }
    return makePassedVerdict();
  };

  const kernel = new NodeLoopKernel({
    node,
    input: {},
    context,
    executor,
    evaluator,
    logger: makeSilentLogger(),
  });

  await kernel.run();
  const events = kernel.getEvents();

  // 应有 2 个事件（2 轮迭代）
  assert.equal(events.length, 2, "应有 2 个事件（2 轮迭代）");
  // 第一个事件应为 verification_rejected（首轮失败）
  assert.equal(events[0].eventType, "verification_rejected");
  // 第二个事件应为 verification_passed（第二轮通过）
  assert.equal(events[1].eventType, "verification_passed");
  // 事件应含 payload
  assert.ok(events[0].payload, "事件应有 payload");
  assert.ok(events[1].payload, "事件应有 payload");
});

// ============================================================================
// N12. getCumulativeTokens() 累计 token
// ============================================================================

test("N12. getCumulativeTokens() 返回累计 token 消耗", async () => {
  const node = makeLoopNode("loop1", [], [], 10);
  const context = makeRunContext();

  let evaluatorCallCount = 0;
  const executor: LoopExecutorCallback = async (iteration) => {
    // 每轮消耗 100 token
    return makeGeneratorResult({ result: `第${iteration}轮` }, 100);
  };
  const evaluator: LoopEvaluatorCallback = async () => {
    evaluatorCallCount++;
    if (evaluatorCallCount === 1) {
      return makeFailedVerdict();
    }
    return makePassedVerdict();
  };

  const kernel = new NodeLoopKernel({
    node,
    input: {},
    context,
    executor,
    evaluator,
    logger: makeSilentLogger(),
  });

  await kernel.run();
  const tokens = kernel.getCumulativeTokens();

  // 2 轮 × 每轮 100 token = 200 token
  assert.equal(tokens, 200, "应累计 2 轮的 token 消耗（2 × 100 = 200）");
});

// ============================================================================
// N13. token 累加到 context.totalTokensUsed
// ============================================================================

test("N13. executor 的 token_used 累加到 context.totalTokensUsed", async () => {
  const node = makeLoopNode("loop1", [], [], 10);
  const context = makeRunContext({ totalTokensUsed: 0 });

  let evaluatorCallCount = 0;
  const executor: LoopExecutorCallback = async (iteration) => {
    return makeGeneratorResult({ result: `第${iteration}轮` }, 150);
  };
  const evaluator: LoopEvaluatorCallback = async () => {
    evaluatorCallCount++;
    if (evaluatorCallCount === 1) {
      return makeFailedVerdict();
    }
    return makePassedVerdict();
  };

  const kernel = new NodeLoopKernel({
    node,
    input: {},
    context,
    executor,
    evaluator,
    logger: makeSilentLogger(),
  });

  await kernel.run();

  // 2 轮 × 每轮 150 token = 300 token
  assert.equal(context.totalTokensUsed, 300, "context.totalTokensUsed 应累加到 300");
});

// ============================================================================
// N14. 五步闭环：feedback 传递给 executor（修复轮）
// ============================================================================

test("N14. 修复轮 executor 收到上一轮的 feedback", async () => {
  const node = makeLoopNode("loop1", [], [], 10);
  const context = makeRunContext();

  // 记录每轮 executor 收到的 feedback
  const receivedFeedbacks: (LoopEvaluationVerdict | undefined)[] = [];

  const executor: LoopExecutorCallback = async (_iteration, _input, _ctx, feedback) => {
    receivedFeedbacks.push(feedback);
    return makeGeneratorResult({ result: "结果" });
  };
  let evaluatorCallCount = 0;
  const evaluator: LoopEvaluatorCallback = async () => {
    evaluatorCallCount++;
    if (evaluatorCallCount === 1) {
      return makeFailedVerdict("test-evaluator", "首轮测试失败");
    }
    return makePassedVerdict();
  };

  const kernel = new NodeLoopKernel({
    node,
    input: {},
    context,
    executor,
    evaluator,
    logger: makeSilentLogger(),
  });

  await kernel.run();

  // 首轮 feedback 应为 undefined，第二轮应为上一轮的 verdict
  assert.equal(receivedFeedbacks.length, 2, "executor 应被调用 2 次");
  assert.equal(receivedFeedbacks[0], undefined, "首轮 feedback 应为 undefined");
  assert.ok(receivedFeedbacks[1], "第二轮应有 feedback");
  assert.equal(receivedFeedbacks[1]!.passed, false, "第二轮 feedback 应为首轮的失败判定");
  assert.match(receivedFeedbacks[1]!.reason, /首轮测试失败/);
});

// ============================================================================
// N15. 输出提取：generatorResult 无 output 字段时使用整个 generatorResult
// ============================================================================

test("N15. generatorResult 无 output 字段时提取整个 generatorResult 作为输出", async () => {
  const node = makeLoopNode("loop1", [], [], 10);
  const context = makeRunContext();

  // executor 返回的 generatorResult 无 output 字段
  const executor: LoopExecutorCallback = async () => {
    return { success: true, customField: "自定义字段值", token_used: 0 };
  };
  const evaluator: LoopEvaluatorCallback = async () => {
    return makePassedVerdict();
  };

  const kernel = new NodeLoopKernel({
    node,
    input: {},
    context,
    executor,
    evaluator,
    logger: makeSilentLogger(),
  });

  const result = await kernel.run();

  assert.equal(result.status, "completed");
  // 无 output 字段时，整个 generatorResult 作为输出
  assert.equal(result.output.success, true);
  assert.equal(result.output.customField, "自定义字段值");
});

// ============================================================================
// N16. 五步闭环：evaluator 抛出异常 → failed
// ============================================================================

test("N16. evaluator 抛出异常时返回 failed", async () => {
  const node = makeLoopNode("loop1", [], [], 10);
  const context = makeRunContext();

  const executor: LoopExecutorCallback = async () => {
    return makeGeneratorResult({ result: "结果" });
  };
  const evaluator: LoopEvaluatorCallback = async () => {
    throw new Error("evaluator 执行失败：测试框架异常");
  };

  const kernel = new NodeLoopKernel({
    node,
    input: {},
    context,
    executor,
    evaluator,
    logger: makeSilentLogger(),
  });

  const result = await kernel.run();

  assert.equal(result.status, "failed", "evaluator 抛出异常时应为 failed");
  assert.match(result.failureReason!, /Loop 执行异常/);
});

// ============================================================================
// N17. 构造校验：inputContract 类型不匹配 → 抛出
// ============================================================================

test("N17. NodeLoopKernel 构造时输入字段类型不匹配抛出", () => {
  const node = makeLoopNode("loop1", [{ name: "count", type: "number", required: true }]);
  const context = makeRunContext();

  // input 中 count 是字符串而非 number
  assert.throws(
    () =>
      new NodeLoopKernel({
        node,
        input: { count: "not-a-number" },
        context,
        executor: async () => ({}),
        evaluator: async () => makePassedVerdict(),
      }),
    /类型不匹配|count/,
    "输入字段类型不匹配时应抛出"
  );
});
