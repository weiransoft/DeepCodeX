/**
 * EAG-Graph NodeLoopKernel 经验召回集成测试（Phase 4）
 *
 * 测试范围（对齐设计文档 §12.3 Phase 4 经验自进化集成）：
 * - R1. enableExperienceRecall=false 时不召回（recalledCases 为空，globalState 无 __experienceRecall）
 * - R2. enableExperienceRecall=true 但 experienceStore 未注入时不召回
 * - R3. enableExperienceRecall=true 且 experienceStore 有相似案例时召回（recalledCases 非空）
 * - R4. 召回的案例存入 context.globalState.__experienceRecall（供 executor 读取）
 * - R5. executor 可从 context.globalState.__experienceRecall 读取召回案例
 * - R6. experienceStore.recallSimilar 抛出异常时不影响主流程（finalStatus 仍为 completed）
 * - R7. 召回的案例在 events 的 payload 中可访问（通过 getEvents 检查）
 * - R8. 任务特征提取包含 taskType / nodeType / input 字段（间接验证：通过召回结果匹配）
 * - R9. 召回结果为空时（无相似案例）recalledCases 为空数组，不影响主流程
 * - R10. getRecalledCases() 在 run() 前返回空数组，run() 后返回召回结果
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止使用 mock 框架，使用真实的 ExperienceStoreImpl 实例和真实函数回调
 * - 每个测试用例独立，无共享可变状态
 *
 * 设计依据：
 * - LOOP-GRAPH-FUSION-DESIGN.md §12.3 Phase 4 经验自进化集成
 * - LOOP-GRAPH-FUSION-DESIGN.md §14.1 经验召回相似度算法
 * - eag/graph/node-loop-kernel.ts 源文件（被测对象）
 * - eag/graph/experience-store.ts 真实 ExperienceStoreImpl 实现
 *
 * @module core/tests/eag-graph-node-loop-kernel-recall
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { NodeLoopKernel } from "../eag/graph/node-loop-kernel";
import type { LoopExecutorCallback, LoopEvaluatorCallback } from "../eag/graph/node-loop-kernel";
import { DEFAULT_WORK_GRAPH_CONFIG, DEFAULT_NODE_LOOP_CONFIG } from "../eag/graph/graph-loop-models";
import type {
  GraphNodeDef,
  GraphRunContext,
  GraphNodeResult,
  NodeFieldContract,
  PredicateRegistry,
  PredicateFunction,
  WorkGraphConfig,
  ExperienceCase,
} from "../eag/graph/graph-loop-models";
import type { LoopEvaluationVerdict, GeneratorResult } from "../eag/loop/models";
import { ExperienceStoreImpl } from "../eag/graph/experience-store";
import type { ExperienceStoreProtocol } from "../eag/graph/graph-loop-protocols";

// ============================================================================
// 辅助：构造测试数据
// ============================================================================

/**
 * 构造一个 loop 节点定义
 *
 * @param nodeId 节点 ID
 * @param overrides 节点级配置覆盖（可选，用于注入任务特征字段）
 * @param inputContract 输入契约（默认空）
 * @param outputContract 输出契约（默认空）
 * @param maxIterations 最大迭代次数（默认 10）
 */
function makeLoopNode(
  nodeId: string,
  overrides?: Record<string, unknown>,
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
    overrides,
  };
}

/**
 * 构造一个最小可用的 GraphRunContext
 *
 * @param enableExperienceRecall 是否启用经验召回（默认 false）
 * @param overrides 部分字段覆盖
 */
function makeRunContext(
  enableExperienceRecall: boolean = false,
  overrides?: Partial<GraphRunContext>
): GraphRunContext {
  // 合并图级配置：默认配置 + enableExperienceRecall 覆盖
  const config: WorkGraphConfig = {
    ...DEFAULT_WORK_GRAPH_CONFIG,
    enableExperienceRecall,
  };
  return {
    runId: overrides?.runId ?? "run-recall-001",
    graphId: overrides?.graphId ?? "g-recall",
    globalState: overrides?.globalState ?? {},
    visited: overrides?.visited ?? new Set<string>(),
    nodeResults: overrides?.nodeResults ?? new Map<string, GraphNodeResult>(),
    cancelled: overrides?.cancelled ?? false,
    config: overrides?.config ?? config,
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
 * 构造一个含 output 字段的 GeneratorResult
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

/**
 * 构造一个经验案例
 *
 * @param caseId 案例 ID
 * @param taskType 任务类型
 * @param taskFeatures 任务特征
 * @param success 是否成功
 * @param strategy 使用的策略
 */
function makeExperienceCase(
  caseId: string,
  taskType: string,
  taskFeatures: Record<string, unknown>,
  success: boolean = true,
  strategy: string = "loop-with-strict-evaluator"
): ExperienceCase {
  return {
    caseId,
    taskType,
    taskFeatures,
    strategy,
    success,
    executionTimeSec: 100.0,
    createdAt: new Date().toISOString(),
  };
}

/**
 * 创建一个预填充案例的 ExperienceStore（真实实现）
 *
 * @param cases 预填充的案例列表
 * @returns ExperienceStoreImpl 实例
 */
function createPrefilledExperienceStore(cases: ExperienceCase[]): ExperienceStoreImpl {
  const store = new ExperienceStoreImpl({}, makeSilentLogger());
  for (const caseData of cases) {
    store.storeCase(caseData);
  }
  return store;
}

// ============================================================================
// R1. enableExperienceRecall=false 时不召回
// ============================================================================

test("R1. enableExperienceRecall=false 时不执行经验召回", async () => {
  const node = makeLoopNode("loop-r1");
  // context 配置 enableExperienceRecall=false（默认）
  const context = makeRunContext(false);

  // 即使注入 experienceStore，也不会召回
  const store = createPrefilledExperienceStore([
    makeExperienceCase("case-1", "coding", { taskType: "coding", nodeType: "loop" }),
  ]);

  // executor 返回成功结果
  let executorCalled = 0;
  const executor: LoopExecutorCallback = async () => {
    executorCalled++;
    return makeGeneratorResult({ result: "完成" });
  };
  const evaluator: LoopEvaluatorCallback = async () => makePassedVerdict();

  const kernel = new NodeLoopKernel({
    node,
    input: {},
    context,
    executor,
    evaluator,
    experienceStore: store,
    logger: makeSilentLogger(),
  });

  const result = await kernel.run();

  // 验证：未启用召回时，recalledCases 为空，globalState 无 __experienceRecall
  assert.equal(result.status, "completed", "节点应成功完成");
  assert.equal(kernel.getRecalledCases().length, 0, "未启用召回时 recalledCases 应为空");
  assert.equal(
    context.globalState["__experienceRecall"],
    undefined,
    "未启用召回时 globalState 不应包含 __experienceRecall"
  );
  assert.equal(executorCalled, 1, "executor 应被调用 1 次");
});

// ============================================================================
// R2. enableExperienceRecall=true 但 experienceStore 未注入时不召回
// ============================================================================

test("R2. enableExperienceRecall=true 但未注入 experienceStore 时跳过召回", async () => {
  const node = makeLoopNode("loop-r2");
  // context 配置 enableExperienceRecall=true
  const context = makeRunContext(true);

  // 不注入 experienceStore
  const executor: LoopExecutorCallback = async () => {
    return makeGeneratorResult({ result: "完成" });
  };
  const evaluator: LoopEvaluatorCallback = async () => makePassedVerdict();

  const kernel = new NodeLoopKernel({
    node,
    input: {},
    context,
    executor,
    evaluator,
    // 不注入 experienceStore
    logger: makeSilentLogger(),
  });

  const result = await kernel.run();

  // 验证：启用召回但未注入 store 时，recalledCases 为空，不影响主流程
  assert.equal(result.status, "completed", "节点应成功完成");
  assert.equal(kernel.getRecalledCases().length, 0, "未注入 store 时 recalledCases 应为空");
  assert.equal(
    context.globalState["__experienceRecall"],
    undefined,
    "未注入 store 时 globalState 不应包含 __experienceRecall"
  );
});

// ============================================================================
// R3. enableExperienceRecall=true 且 experienceStore 有相似案例时召回
// ============================================================================

test("R3. 启用召回且 experienceStore 有相似案例时召回成功", async () => {
  const node = makeLoopNode("loop-r3");
  // context 配置 enableExperienceRecall=true
  const context = makeRunContext(true);

  // 预填充相似案例：taskType="coding", nodeType="loop"（与节点特征完全匹配）
  const similarCase = makeExperienceCase(
    "case-similar-r3",
    "coding",
    { taskType: "coding", nodeType: "loop" },
    true,
    "loop-with-strict-evaluator"
  );
  const store = createPrefilledExperienceStore([similarCase]);

  const executor: LoopExecutorCallback = async () => {
    return makeGeneratorResult({ result: "完成" });
  };
  const evaluator: LoopEvaluatorCallback = async () => makePassedVerdict();

  const kernel = new NodeLoopKernel({
    node,
    input: {},
    context,
    executor,
    evaluator,
    experienceStore: store,
    logger: makeSilentLogger(),
  });

  const result = await kernel.run();

  // 验证：召回成功，recalledCases 非空
  assert.equal(result.status, "completed", "节点应成功完成");
  const recalled = kernel.getRecalledCases();
  assert.equal(recalled.length, 1, "应召回 1 个相似案例");
  assert.equal(recalled[0].caseId, "case-similar-r3", "召回的案例 ID 应匹配");
  assert.equal(recalled[0].taskType, "coding", "召回的案例 taskType 应为 coding");
});

// ============================================================================
// R4. 召回的案例存入 context.globalState.__experienceRecall
// ============================================================================

test("R4. 召回的案例同步写入 context.globalState.__experienceRecall", async () => {
  const node = makeLoopNode("loop-r4");
  const context = makeRunContext(true);

  const similarCase = makeExperienceCase("case-globalstate-r4", "coding", { taskType: "coding", nodeType: "loop" });
  const store = createPrefilledExperienceStore([similarCase]);

  const executor: LoopExecutorCallback = async () => {
    return makeGeneratorResult({ result: "完成" });
  };
  const evaluator: LoopEvaluatorCallback = async () => makePassedVerdict();

  const kernel = new NodeLoopKernel({
    node,
    input: {},
    context,
    executor,
    evaluator,
    experienceStore: store,
    logger: makeSilentLogger(),
  });

  await kernel.run();

  // 验证：globalState.__experienceRecall 存在且包含召回案例
  const globalRecall = context.globalState["__experienceRecall"];
  assert.ok(Array.isArray(globalRecall), "__experienceRecall 应为数组");
  assert.equal(globalRecall.length, 1, "__experienceRecall 应包含 1 个案例");
  assert.equal(globalRecall[0].caseId, "case-globalstate-r4", "__experienceRecall 中的案例 ID 应匹配");
});

// ============================================================================
// R5. executor 可从 context.globalState.__experienceRecall 读取召回案例
// ============================================================================

test("R5. executor 可从 context.globalState 读取召回的案例", async () => {
  const node = makeLoopNode("loop-r5");
  const context = makeRunContext(true);

  const similarCase = makeExperienceCase(
    "case-exec-read-r5",
    "coding",
    { taskType: "coding", nodeType: "loop" },
    true,
    "fast-fix-strategy"
  );
  const store = createPrefilledExperienceStore([similarCase]);

  // executor 在执行时从 context.globalState 读取召回案例
  let executorSawRecalledCases: ExperienceCase[] | null = null;
  const executor: LoopExecutorCallback = async (_iter, _input, ctx) => {
    const recall = ctx.globalState["__experienceRecall"];
    if (Array.isArray(recall)) {
      executorSawRecalledCases = recall as ExperienceCase[];
    }
    return makeGeneratorResult({ result: "完成" });
  };
  const evaluator: LoopEvaluatorCallback = async () => makePassedVerdict();

  const kernel = new NodeLoopKernel({
    node,
    input: {},
    context,
    executor,
    evaluator,
    experienceStore: store,
    logger: makeSilentLogger(),
  });

  await kernel.run();

  // 验证：executor 能从 context.globalState 读取召回案例
  assert.ok(executorSawRecalledCases !== null, "executor 应能读取 __experienceRecall");
  assert.equal(executorSawRecalledCases!.length, 1, "executor 读取的召回案例数应为 1");
  assert.equal(executorSawRecalledCases![0].caseId, "case-exec-read-r5", "executor 读取的案例 ID 应匹配");
  assert.equal(executorSawRecalledCases![0].strategy, "fast-fix-strategy", "executor 读取的案例策略应匹配");
});

// ============================================================================
// R6. experienceStore.recallSimilar 抛出异常时不影响主流程
// ============================================================================

test("R6. experienceStore.recallSimilar 抛出异常时不影响主流程", async () => {
  const node = makeLoopNode("loop-r6");
  const context = makeRunContext(true);

  // 构造一个会在 recallSimilar 抛出异常的 ExperienceStore（真实实现，不使用 mock）
  // 通过继承 ExperienceStoreImpl 并重写 recallSimilar 方法实现
  class ThrowingExperienceStore extends ExperienceStoreImpl {
    async recallSimilar(
      _taskFeatures: Readonly<Record<string, unknown>>,
      _limit: number
    ): Promise<ReadonlyArray<ExperienceCase>> {
      throw new Error("模拟召回服务不可用");
    }
  }
  const store: ExperienceStoreProtocol = new ThrowingExperienceStore({}, makeSilentLogger());

  const executor: LoopExecutorCallback = async () => {
    return makeGeneratorResult({ result: "完成" });
  };
  const evaluator: LoopEvaluatorCallback = async () => makePassedVerdict();

  const kernel = new NodeLoopKernel({
    node,
    input: {},
    context,
    executor,
    evaluator,
    experienceStore: store,
    logger: makeSilentLogger(),
  });

  const result = await kernel.run();

  // 验证：召回异常时不影响主流程，finalStatus 仍为 completed
  assert.equal(result.status, "completed", "召回异常时节点仍应成功完成");
  assert.equal(kernel.getRecalledCases().length, 0, "召回异常时 recalledCases 应为空");
  assert.equal(
    context.globalState["__experienceRecall"],
    undefined,
    "召回异常时 globalState 不应包含 __experienceRecall"
  );
});

// ============================================================================
// R7. 召回的案例在 events 的 payload 中可访问
// ============================================================================

test("R7. 召回的案例在 events 的 payload 中可访问", async () => {
  const node = makeLoopNode("loop-r7");
  const context = makeRunContext(true);

  const similarCase = makeExperienceCase("case-event-r7", "coding", { taskType: "coding", nodeType: "loop" });
  const store = createPrefilledExperienceStore([similarCase]);

  const executor: LoopExecutorCallback = async () => {
    return makeGeneratorResult({ result: "完成" });
  };
  const evaluator: LoopEvaluatorCallback = async () => makePassedVerdict();

  const kernel = new NodeLoopKernel({
    node,
    input: {},
    context,
    executor,
    evaluator,
    experienceStore: store,
    logger: makeSilentLogger(),
  });

  await kernel.run();

  // 验证：events 的 payload 中包含 recalledCases
  const events = kernel.getEvents();
  assert.ok(events.length > 0, "应有事件记录");
  const firstEvent = events[0];
  const payload = firstEvent.payload as Record<string, unknown>;
  assert.ok(Object.prototype.hasOwnProperty.call(payload, "recalledCases"), "event payload 应包含 recalledCases 字段");
  const eventRecalledCases = payload["recalledCases"] as ExperienceCase[];
  assert.equal(eventRecalledCases.length, 1, "event payload 中的召回案例数应为 1");
  assert.equal(eventRecalledCases[0].caseId, "case-event-r7", "event payload 中的案例 ID 应匹配");
});

// ============================================================================
// R8. 任务特征提取包含 taskType / nodeType / input 字段
// ============================================================================

test("R8. 任务特征提取包含 taskType / nodeType / overrides / input 字段", async () => {
  // 构造一个带 overrides 和 input 特征的节点
  const node = makeLoopNode("loop-r8", {
    language: "typescript",
    complexity: "high",
  });
  // context 配置 enableExperienceRecall=true
  const context = makeRunContext(true);

  // 预填充案例：特征完全匹配（taskType + nodeType + language + complexity + input 字段）
  const matchingCase = makeExperienceCase("case-features-r8", "coding", {
    taskType: "coding",
    nodeType: "loop",
    language: "typescript",
    complexity: "high",
    framework: "react", // 来自 input
  });
  // 预填充一个不匹配的案例（language 不同）
  const nonMatchingCase = makeExperienceCase("case-nomatch-r8", "coding", {
    taskType: "coding",
    nodeType: "loop",
    language: "python", // 不匹配
    complexity: "high",
  });
  const store = createPrefilledExperienceStore([matchingCase, nonMatchingCase]);

  // input 中包含 framework 字段（基本类型，应被提取为特征）
  const input = { framework: "react" };

  const executor: LoopExecutorCallback = async () => {
    return makeGeneratorResult({ result: "完成" });
  };
  const evaluator: LoopEvaluatorCallback = async () => makePassedVerdict();

  const kernel = new NodeLoopKernel({
    node,
    input,
    context,
    executor,
    evaluator,
    experienceStore: store,
    logger: makeSilentLogger(),
  });

  await kernel.run();

  // 验证：特征提取正确，召回完全匹配的案例（language=typescript, framework=react）
  // 不召回 language=python 的案例（相似度低于 1.0，但可能仍高于阈值 0.5）
  const recalled = kernel.getRecalledCases();
  assert.ok(recalled.length > 0, "应召回至少 1 个案例");

  // 完全匹配的案例应排在第一位（相似度最高）
  assert.equal(recalled[0].caseId, "case-features-r8", "完全匹配的案例应排在第一位（相似度最高）");
  assert.equal(recalled[0].taskFeatures.language, "typescript", "language 应为 typescript");
});

// ============================================================================
// R9. 召回结果为空时（无相似案例）recalledCases 为空数组，不影响主流程
// ============================================================================

test("R9. 案例库为空时召回结果为空数组，不影响主流程", async () => {
  const node = makeLoopNode("loop-r9");
  const context = makeRunContext(true);

  // 空的 ExperienceStore
  const store = new ExperienceStoreImpl({}, makeSilentLogger());

  const executor: LoopExecutorCallback = async () => {
    return makeGeneratorResult({ result: "完成" });
  };
  const evaluator: LoopEvaluatorCallback = async () => makePassedVerdict();

  const kernel = new NodeLoopKernel({
    node,
    input: {},
    context,
    executor,
    evaluator,
    experienceStore: store,
    logger: makeSilentLogger(),
  });

  const result = await kernel.run();

  // 验证：空案例库时 recalledCases 为空数组，不影响主流程
  assert.equal(result.status, "completed", "节点应成功完成");
  assert.equal(kernel.getRecalledCases().length, 0, "空案例库时 recalledCases 应为空数组");
  // globalState.__experienceRecall 应为空数组（不是 undefined）
  const globalRecall = context.globalState["__experienceRecall"];
  assert.ok(Array.isArray(globalRecall), "__experienceRecall 应为数组（即使为空）");
  assert.equal(globalRecall.length, 0, "__experienceRecall 应为空数组");
});

// ============================================================================
// R10. getRecalledCases() 在 run() 前返回空数组，run() 后返回召回结果
// ============================================================================

test("R10. getRecalledCases() 在 run() 前后行为正确", async () => {
  const node = makeLoopNode("loop-r10");
  const context = makeRunContext(true);

  const similarCase = makeExperienceCase("case-before-after-r10", "coding", { taskType: "coding", nodeType: "loop" });
  const store = createPrefilledExperienceStore([similarCase]);

  const executor: LoopExecutorCallback = async () => {
    return makeGeneratorResult({ result: "完成" });
  };
  const evaluator: LoopEvaluatorCallback = async () => makePassedVerdict();

  const kernel = new NodeLoopKernel({
    node,
    input: {},
    context,
    executor,
    evaluator,
    experienceStore: store,
    logger: makeSilentLogger(),
  });

  // 验证：run() 前 recalledCases 为空
  assert.equal(kernel.getRecalledCases().length, 0, "run() 前 recalledCases 应为空数组");

  await kernel.run();

  // 验证：run() 后 recalledCases 包含召回结果
  const recalled = kernel.getRecalledCases();
  assert.equal(recalled.length, 1, "run() 后 recalledCases 应包含 1 个案例");
  assert.equal(recalled[0].caseId, "case-before-after-r10", "run() 后 recalledCases 的案例 ID 应匹配");
});
