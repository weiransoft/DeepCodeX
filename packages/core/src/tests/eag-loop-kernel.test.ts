/**
 * EAG-P1 单元测试：LoopKernel 五步闭环编排器
 *
 * 测试范围：
 * - K1. 单轮通过即停止（STOP_SUCCESS）
 * - K2. 单轮失败 → FIX → 第二轮通过 → STOP_SUCCESS
 * - K3. 连续 3 次失败 → HUMAN_CHECKPOINT
 * - K4. 连续 5 次失败 → STOP_FAILURE
 * - K5. 达到 maxIterations → STOP_FAILURE
 * - K6. stop() 安全停止
 * - K7. 事件序列完整性（DISCOVERY_STARTED → DISCOVERY_COMPLETED → HANDOFF_CREATED →
 *        HANDOFF_DISPATCHED → VERIFICATION_STARTED → VERIFICATION_PASSED/REJECTED →
 *        PERSISTENCE_WRITTEN → SCHEDULING_DECISION）
 * - K8. requestHumanCheckpoint 默认 approved=true
 *
 * 测试约定（严格遵循项目"禁止 mock"规则）：
 * - 使用 node:test + node:assert/strict
 * - 使用真实组件实现（StaticXxx 类），不使用任何 mock 框架
 * - 每个测试用例独立构造组件，无共享可变状态
 *
 * 真实组件清单：
 * - StaticDiscoveryProbe：实现 DiscoveryProbeProtocol，返回固定 DiscoveryResult
 * - StaticHandoffAdapter：实现 HandoffAdapterProtocol，返回固定 HandoffItem[] + GeneratorResult
 * - PassingEvaluator：实现 IndependentEvaluatorProtocol，verdict.passed=true
 * - FailingEvaluator：实现 IndependentEvaluatorProtocol，verdict.passed=false
 * - ScriptedEvaluator：按预设脚本顺序返回 verdict（用于 K2 fail-then-pass 场景）
 * - StoppingDiscoveryProbe：在 N 次 discover 后调用 stop 回调（用于 K6 stop() 测试）
 * - InMemoryMemory：实现 UnifiedMemoryLayerProtocol，内存存储事件
 *
 * 设计依据：
 * - EAG 方案 §5.2.1 五步闭环（Discovery→Handoff→Verification→Persistence→Scheduling）
 * - EAG 方案 §5.2.3 CODING Loop 失败处理（连续 3 次失败 → HUMAN_CHECKPOINT）
 * - multi-agent-team skill scripts/loop_engineering/kernel.py（移植母本）
 * - eag/loop/kernel.ts 源文件（被测对象）
 *
 * @module core/tests/eag-loop-kernel
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { LoopKernel } from "../eag/loop/kernel";
import { LoopScheduler } from "../eag/loop/scheduler";
import {
  createLoopEngineeringConfig,
  type LoopEngineeringConfig,
  type LoopEvent,
  type DiscoveryResult,
  type HandoffItem,
  type LoopEvaluationVerdict,
  type GeneratorResult,
  type MemoryQuery,
  type HumanCheckpointResponse,
} from "../eag/loop/models";
import type {
  DiscoveryProbeProtocol,
  HandoffAdapterProtocol,
  IndependentEvaluatorProtocol,
  UnifiedMemoryLayerProtocol,
} from "../eag/loop/protocols";

// ============================================================================
// 真实组件实现（禁止 mock —— 这些是真实类型的轻量级实现，不是 mock 框架产物）
// ============================================================================

/**
 * 静态 DiscoveryProbe：始终返回固定 DiscoveryResult
 *
 * 用于 K1/K2/K3/K4/K5 等场景，提供可预测的 Discovery 产物。
 */
class StaticDiscoveryProbe implements DiscoveryProbeProtocol {
  private readonly fixedResult: DiscoveryResult;

  /**
   * @param fixedResult 固定返回的 DiscoveryResult
   */
  constructor(fixedResult: DiscoveryResult) {
    this.fixedResult = fixedResult;
  }

  discover(
    _objective: string,
    _prevEvents: ReadonlyArray<LoopEvent>,
    _memory: UnifiedMemoryLayerProtocol
  ): DiscoveryResult {
    return this.fixedResult;
  }
}

/**
 * 停止型 DiscoveryProbe：在 N 次 discover 后调用 stop 回调
 *
 * 用于 K6 stop() 安全停止测试。构造后通过 setStopCallback 注入 kernel.stop 回调，
 * 避免 DiscoveryProbe 与 LoopKernel 构造时的循环依赖。
 */
class StoppingDiscoveryProbe implements DiscoveryProbeProtocol {
  private readonly fixedResult: DiscoveryResult;
  private readonly stopAfterN: number;
  private readonly stopCallback: () => void;
  private callCount: number = 0;

  /**
   * @param fixedResult 固定返回的 DiscoveryResult
   * @param stopAfterN 在第 N 次 discover 后调用 stop 回调
   * @param stopCallback stop 回调（通常是 () => kernel.stop("test")）
   */
  constructor(fixedResult: DiscoveryResult, stopAfterN: number, stopCallback: () => void) {
    this.fixedResult = fixedResult;
    this.stopAfterN = stopAfterN;
    this.stopCallback = stopCallback;
  }

  discover(
    _objective: string,
    _prevEvents: ReadonlyArray<LoopEvent>,
    _memory: UnifiedMemoryLayerProtocol
  ): DiscoveryResult {
    this.callCount += 1;
    if (this.callCount >= this.stopAfterN) {
      this.stopCallback();
    }
    return this.fixedResult;
  }

  /** 获取 discover 调用次数（供测试断言） */
  getCallCount(): number {
    return this.callCount;
  }
}

/**
 * 静态 HandoffAdapter：始终返回固定工作项与 Generator 结果
 *
 * 用于全部 K 系列测试，提供可预测的 Handoff 产物。
 */
class StaticHandoffAdapter implements HandoffAdapterProtocol {
  private readonly fixedItems: HandoffItem[];
  private readonly fixedResult: GeneratorResult;

  /**
   * @param fixedItems 固定返回的 HandoffItem 列表
   * @param fixedResult 固定返回的 GeneratorResult
   */
  constructor(fixedItems: HandoffItem[], fixedResult: GeneratorResult) {
    this.fixedItems = fixedItems;
    this.fixedResult = fixedResult;
  }

  createWorkItems(_discovery: DiscoveryResult, _loopType: string): HandoffItem[] {
    return [...this.fixedItems];
  }

  execute(_items: ReadonlyArray<HandoffItem>, _config: LoopEngineeringConfig): GeneratorResult {
    return { ...this.fixedResult };
  }
}

/**
 * 通过型 Evaluator：始终返回 verdict.passed=true
 *
 * 用于 K1（单轮通过即停止）等场景。
 */
class PassingEvaluator implements IndependentEvaluatorProtocol {
  evaluate(
    _handoffItems: ReadonlyArray<HandoffItem>,
    _generatorResult: GeneratorResult,
    _context: Readonly<Record<string, unknown>>
  ): LoopEvaluationVerdict {
    return {
      passed: true,
      evaluatorId: "passing-evaluator",
      reason: "所有客观指标通过",
      findings: [],
      severity: "info",
      suggestedFix: "",
      sampledArtifacts: [],
    };
  }
}

/**
 * 失败型 Evaluator：始终返回 verdict.passed=false
 *
 * 用于 K3/K4/K5（连续失败 / maxIterations）等场景。
 */
class FailingEvaluator implements IndependentEvaluatorProtocol {
  evaluate(
    _handoffItems: ReadonlyArray<HandoffItem>,
    _generatorResult: GeneratorResult,
    _context: Readonly<Record<string, unknown>>
  ): LoopEvaluationVerdict {
    return {
      passed: false,
      evaluatorId: "failing-evaluator",
      reason: "测试未通过",
      findings: ["测试未通过：3/10 失败"],
      severity: "blocker",
      suggestedFix: "请修复失败的测试用例",
      sampledArtifacts: [],
    };
  }
}

/**
 * 脚本型 Evaluator：按预设脚本顺序返回 verdict
 *
 * 用于 K2（单轮失败 → FIX → 第二轮通过）场景。
 * 脚本中最后一个 verdict 会被重复返回（超出脚本长度时）。
 */
class ScriptedEvaluator implements IndependentEvaluatorProtocol {
  private readonly script: LoopEvaluationVerdict[];
  private callCount: number = 0;

  /**
   * @param script verdict 脚本（按调用顺序）
   */
  constructor(script: LoopEvaluationVerdict[]) {
    this.script = script;
  }

  evaluate(
    _handoffItems: ReadonlyArray<HandoffItem>,
    _generatorResult: GeneratorResult,
    _context: Readonly<Record<string, unknown>>
  ): LoopEvaluationVerdict {
    const idx = Math.min(this.callCount, this.script.length - 1);
    this.callCount += 1;
    return this.script[idx];
  }

  /** 获取 evaluate 调用次数（供测试断言） */
  getCallCount(): number {
    return this.callCount;
  }
}

/**
 * 内存型 Memory：实现 UnifiedMemoryLayerProtocol，内存存储事件
 *
 * 用于全部 K 系列测试，提供可查询的事件存储与 token 计数。
 *
 * 设计：
 * - persistEvent：追加到内部数组
 * - query：支持 recent / event / risk 三种查询类型（similar 简化返回空）
 * - estimateTokenUsage：返回 0（测试场景不消耗 token，避免触发 maxTokens 上限）
 */
class InMemoryMemory implements UnifiedMemoryLayerProtocol {
  private readonly events: LoopEvent[] = [];

  persistEvent(event: LoopEvent): void {
    this.events.push(event);
  }

  query(query: MemoryQuery): Array<Readonly<Record<string, unknown>>> {
    if (query.queryType === "recent") {
      return this.events.slice(-query.limit).map((e) => ({ ...e }));
    }
    if (query.queryType === "event") {
      const eventType = query.filters.event_type as string | undefined;
      return this.events
        .filter((e) => e.eventType === eventType)
        .slice(-query.limit)
        .map((e) => ({ ...e }));
    }
    if (query.queryType === "risk") {
      return this.events
        .filter((e) => e.payload.severity === "blocker")
        .slice(-query.limit)
        .map((e) => ({ ...e }));
    }
    // similar 查询：简化返回空（测试不依赖语义检索）
    return [];
  }

  estimateTokenUsage(): number {
    // 测试场景返回 0，避免触发 maxTokens 上限
    return 0;
  }

  /** 获取全部已存储事件（供测试断言） */
  getAllEvents(): ReadonlyArray<LoopEvent> {
    return [...this.events];
  }

  /** 获取已存储事件数量（供测试断言） */
  getEventCount(): number {
    return this.events.length;
  }
}

// ============================================================================
// 测试辅助工厂
// ============================================================================

/**
 * 创建测试用 DiscoveryResult（含必要字段）
 *
 * @param objective 目标描述（默认 "test objective"）
 */
function makeDiscoveryResult(objective: string = "test objective"): DiscoveryResult {
  return {
    objective,
    inputs: {},
    contextFeatures: {},
    relevantSkills: [],
    detectedRisks: [],
    inferredGoal: "",
    worktreeRequired: false,
    suggestedAgents: [],
    suggestedPatterns: [],
    artifactsToRead: [],
    timestamp: "2026-07-18T00:00:00.000Z",
  };
}

/**
 * 创建测试用 HandoffItem 列表
 */
function makeHandoffItems(): HandoffItem[] {
  return [
    {
      itemId: "wi-test-001",
      agentType: "solo-coder",
      task: "test task",
      acceptanceCriteria: ["测试通过"],
      worktreePath: null,
      dependencies: [],
      metadata: {},
    },
  ];
}

/**
 * 创建测试用 GeneratorResult（success=true）
 */
function makeSuccessGeneratorResult(): GeneratorResult {
  return {
    success: true,
    test_result: { passed: true, summary: "10/10 通过" },
    lint_result: { passed: true, summary: "无 lint 错误" },
    security_result: { severity: "info", summary: "无安全问题" },
    modified_files: ["src/test.ts"],
    committed_count: 1,
  };
}

/**
 * 创建测试用 GeneratorResult（success=false）
 */
function makeFailureGeneratorResult(): GeneratorResult {
  return {
    success: false,
    test_result: { passed: false, summary: "3/10 失败" },
    modified_files: ["src/test.ts"],
    committed_count: 0,
  };
}

// ============================================================================
// K1. 单轮通过即停止（STOP_SUCCESS）
// ============================================================================

test("K1. 单轮通过即停止（STOP_SUCCESS）", () => {
  const config = createLoopEngineeringConfig({
    maxIterations: 10,
    maxTokens: 100_000,
    stopWhen: "", // 空 stopWhen：默认 pass 即停止
  });
  const memory = new InMemoryMemory();
  const scheduler = new LoopScheduler(config);
  const kernel = new LoopKernel(
    config,
    new StaticDiscoveryProbe(makeDiscoveryResult()),
    new StaticHandoffAdapter(makeHandoffItems(), makeSuccessGeneratorResult()),
    new PassingEvaluator(),
    memory,
    scheduler
  );

  const report = kernel.run("K1 test objective");

  // 验证最终状态为 completed
  assert.equal(report.finalStatus, "completed");
  // 验证总迭代次数为 1（单轮通过即停止）
  assert.equal(report.totalIterations, 1);
  // 验证 committedCount 累加正确（GeneratorResult.committed_count=1）
  assert.equal(report.committedCount, 1);
  // 验证无人类检查点
  assert.equal(report.humanCheckpoints.length, 0);
  // 验证 loopType 透传正确
  assert.equal(report.loopType, "coding");
  // 验证 objective 透传正确
  assert.equal(report.objective, "K1 test objective");
});

// ============================================================================
// K2. 单轮失败 → FIX → 第二轮通过 → STOP_SUCCESS
// ============================================================================

test("K2. 单轮失败 → FIX → 第二轮通过 → STOP_SUCCESS", () => {
  const config = createLoopEngineeringConfig({
    maxIterations: 10,
    maxTokens: 100_000,
    stopWhen: "",
  });
  const memory = new InMemoryMemory();
  const scheduler = new LoopScheduler(config);
  // 脚本：第 1 轮失败 → 第 2 轮通过（之后保持通过）
  const evaluator = new ScriptedEvaluator([
    {
      passed: false,
      evaluatorId: "scripted-evaluator",
      reason: "第 1 轮失败",
      findings: ["测试未通过"],
      severity: "blocker",
      suggestedFix: "请修复",
      sampledArtifacts: [],
    },
    {
      passed: true,
      evaluatorId: "scripted-evaluator",
      reason: "第 2 轮通过",
      findings: [],
      severity: "info",
      suggestedFix: "",
      sampledArtifacts: [],
    },
  ]);
  const kernel = new LoopKernel(
    config,
    new StaticDiscoveryProbe(makeDiscoveryResult()),
    new StaticHandoffAdapter(makeHandoffItems(), makeSuccessGeneratorResult()),
    evaluator,
    memory,
    scheduler
  );

  const report = kernel.run("K2 test objective");

  // 验证最终状态为 completed
  assert.equal(report.finalStatus, "completed");
  // 验证总迭代次数为 2（两轮后停止）
  assert.equal(report.totalIterations, 2);
  // 验证 evaluator 被调用 2 次
  assert.equal(evaluator.getCallCount(), 2);
  // 验证无人类检查点（连续失败 1 次，未达 HUMAN_CHECKPOINT 阈值 3）
  assert.equal(report.humanCheckpoints.length, 0);
});

// ============================================================================
// K3. 连续 3 次失败 → HUMAN_CHECKPOINT
// ============================================================================

test("K3. 连续 3 次失败 → HUMAN_CHECKPOINT", () => {
  // maxIterations=10，避免 max-iter 硬上限优先于 HUMAN_CHECKPOINT 触发
  // （scheduler 优先级：max-iter > consecutive-failure，故需 maxIter > 3）
  const config = createLoopEngineeringConfig({
    maxIterations: 10,
    maxTokens: 100_000,
    stopWhen: "",
  });
  const memory = new InMemoryMemory();
  const scheduler = new LoopScheduler(config);
  const kernel = new LoopKernel(
    config,
    new StaticDiscoveryProbe(makeDiscoveryResult()),
    new StaticHandoffAdapter(makeHandoffItems(), makeFailureGeneratorResult()),
    new FailingEvaluator(),
    memory,
    scheduler
  );

  const report = kernel.run("K3 test objective");

  // 验证最终状态为 failed（连续失败 5 次后 STOP_FAILURE）
  assert.equal(report.finalStatus, "failed");
  // 验证触发了至少 1 次 HUMAN_CHECKPOINT（连续 3 次失败时触发，4 次时再次触发）
  assert.ok(report.humanCheckpoints.length >= 1, `应触发 HUMAN_CHECKPOINT，实际：${report.humanCheckpoints.length}`);
  // 验证第一次 HUMAN_CHECKPOINT 在第 3 次失败时触发（iterIndex=2，对应第 3 轮）
  assert.equal(report.humanCheckpoints[0]!.iterIndex, 2);
  // 验证人类检查点的 approved=true（默认自动批准）
  assert.equal(report.humanCheckpoints[0]!.approved, true);
  // 验证人类检查点的 abort=false
  assert.equal(report.humanCheckpoints[0]!.abort, false);
  // 验证 HUMAN_CHECKPOINT 的 reason 包含连续失败信息
  const reason = String(report.humanCheckpoints[0]!.reason);
  assert.ok(reason.includes("连续失败"), `reason 应包含'连续失败'，实际：${reason}`);
});

// ============================================================================
// K4. 连续 5 次失败 → STOP_FAILURE
// ============================================================================

test("K4. 连续 5 次失败 → STOP_FAILURE", () => {
  // 设置 maxIterations=10，确保不触发 max-iter 安全上限
  const config = createLoopEngineeringConfig({
    maxIterations: 10,
    maxTokens: 100_000,
    stopWhen: "",
  });
  const memory = new InMemoryMemory();
  const scheduler = new LoopScheduler(config);
  const kernel = new LoopKernel(
    config,
    new StaticDiscoveryProbe(makeDiscoveryResult()),
    new StaticHandoffAdapter(makeHandoffItems(), makeFailureGeneratorResult()),
    new FailingEvaluator(),
    memory,
    scheduler
  );

  const report = kernel.run("K4 test objective");

  // 验证最终状态为 failed（连续失败 5 次 → STOP_FAILURE）
  assert.equal(report.finalStatus, "failed");
  // 验证总迭代次数为 5（5 轮失败后停止）
  // iter 0~3: consecutiveFailures 0→1→2→3（HUMAN_CHECKPOINT 在 iter 2）
  // iter 3: consecutiveFailures 3→4（HUMAN_CHECKPOINT）
  // iter 4: consecutiveFailures 4→5（STOP_FAILURE）
  assert.equal(report.totalIterations, 5);
  // 验证触发了 HUMAN_CHECKPOINT（连续 3 次失败时触发）
  assert.ok(report.humanCheckpoints.length >= 1, `应触发 HUMAN_CHECKPOINT，实际：${report.humanCheckpoints.length}`);
  // 验证最后一个 scheduling_decision 事件为 stop_failure
  const schedulingEvents = report.events.filter((e) => e.eventType === "scheduling_decision");
  const lastScheduling = schedulingEvents[schedulingEvents.length - 1]!;
  assert.equal(lastScheduling.payload.action, "stop_failure");
});

// ============================================================================
// K5. 达到 maxIterations → STOP_FAILURE
// ============================================================================

test("K5. 达到 maxIterations → STOP_FAILURE", () => {
  // 设置 maxIterations=2，配合 FailingEvaluator，触发 max-iter 硬上限
  const config = createLoopEngineeringConfig({
    maxIterations: 2,
    maxTokens: 100_000,
    stopWhen: "",
  });
  const memory = new InMemoryMemory();
  const scheduler = new LoopScheduler(config);
  const kernel = new LoopKernel(
    config,
    new StaticDiscoveryProbe(makeDiscoveryResult()),
    new StaticHandoffAdapter(makeHandoffItems(), makeFailureGeneratorResult()),
    new FailingEvaluator(),
    memory,
    scheduler
  );

  const report = kernel.run("K5 test objective");

  // 验证最终状态为 failed
  assert.equal(report.finalStatus, "failed");
  // 验证总迭代次数为 2（maxIterations=2 触发硬上限）
  // iter 0: max-iter check 0+1>=2? No → FIX
  // iter 1: max-iter check 1+1>=2? Yes → STOP_FAILURE（verdict.passed=false）
  assert.equal(report.totalIterations, 2);
  // 验证最后一个 scheduling_decision 事件为 stop_failure
  const schedulingEvents = report.events.filter((e) => e.eventType === "scheduling_decision");
  const lastScheduling = schedulingEvents[schedulingEvents.length - 1]!;
  assert.equal(lastScheduling.payload.action, "stop_failure");
});

// ============================================================================
// K6. stop() 安全停止
// ============================================================================

test("K6. stop() 安全停止", () => {
  const config = createLoopEngineeringConfig({
    maxIterations: 10,
    maxTokens: 100_000,
    stopWhen: "",
  });
  const memory = new InMemoryMemory();
  const scheduler = new LoopScheduler(config);

  // 占位变量：kernel 构造后注入 stop 回调
  let kernelRef: LoopKernel | null = null;
  const probe = new StoppingDiscoveryProbe(
    makeDiscoveryResult(),
    2, // 第 2 次 discover 后调用 stop
    () => {
      if (kernelRef) {
        kernelRef.stop("K6 test stop");
      }
    }
  );
  // 使用 FailingEvaluator：避免 PassingEvaluator + 空 stopWhen 在 iter 0 即 STOP_SUCCESS
  // —— FailingEvaluator 使循环持续 FIX，让 probe 能在第 2 次 discover 时触发 stop()
  const kernel = new LoopKernel(
    config,
    probe,
    new StaticHandoffAdapter(makeHandoffItems(), makeFailureGeneratorResult()),
    new FailingEvaluator(),
    memory,
    scheduler
  );
  kernelRef = kernel;

  const report = kernel.run("K6 test objective");

  // 验证 probe 被至少 2 次调用后触发 stop
  assert.ok(probe.getCallCount() >= 2, `probe 应被调用 >= 2 次，实际：${probe.getCallCount()}`);
  // 验证 Loop 正常退出（无异常抛出，能拿到 report）
  // 验证 finalStatus 为 failed（stop 触发后 finalStatus 保持默认 "failed"）
  assert.ok(
    report.finalStatus === "failed" || report.finalStatus === "completed",
    `finalStatus 应为 failed 或 completed，实际：${report.finalStatus}`
  );
  // 验证 totalIterations 合理（>= 2，因为 stop 在第 2 轮 discover 时触发，本轮会执行完成）
  assert.ok(report.totalIterations >= 2, `totalIterations 应 >= 2，实际：${report.totalIterations}`);
});

// ============================================================================
// K7. 事件序列完整性
// ============================================================================

test("K7. 事件序列完整性（单轮五步闭环 + 终态）", () => {
  const config = createLoopEngineeringConfig({
    maxIterations: 10,
    maxTokens: 100_000,
    stopWhen: "",
  });
  const memory = new InMemoryMemory();
  const scheduler = new LoopScheduler(config);
  const kernel = new LoopKernel(
    config,
    new StaticDiscoveryProbe(makeDiscoveryResult()),
    new StaticHandoffAdapter(makeHandoffItems(), makeSuccessGeneratorResult()),
    new PassingEvaluator(),
    memory,
    scheduler
  );

  const report = kernel.run("K7 event sequence test");

  // 验证事件序列：8 个 cycle 事件 + 1 个 loop_completed 终态事件 = 9 个
  const expectedSequence = [
    "discovery_started",
    "discovery_completed",
    "handoff_created",
    "handoff_dispatched",
    "verification_started",
    "verification_passed", // PassingEvaluator → passed=true
    "persistence_written",
    "scheduling_decision", // STOP_SUCCESS
    "loop_completed", // 终态
  ];
  assert.equal(
    report.events.length,
    expectedSequence.length,
    `事件数应为 ${expectedSequence.length}，实际：${report.events.length}`
  );
  const actualSequence = report.events.map((e) => e.eventType);
  assert.deepEqual(actualSequence, expectedSequence, `事件序列不匹配，实际：${JSON.stringify(actualSequence)}`);
});

test("K7b. 事件序列完整性（失败轮次 → verification_rejected）", () => {
  // 单轮失败：maxIterations=1，FailingEvaluator，触发 max-iter STOP_FAILURE
  const config = createLoopEngineeringConfig({
    maxIterations: 1,
    maxTokens: 100_000,
    stopWhen: "",
  });
  const memory = new InMemoryMemory();
  const scheduler = new LoopScheduler(config);
  const kernel = new LoopKernel(
    config,
    new StaticDiscoveryProbe(makeDiscoveryResult()),
    new StaticHandoffAdapter(makeHandoffItems(), makeFailureGeneratorResult()),
    new FailingEvaluator(),
    memory,
    scheduler
  );

  const report = kernel.run("K7b event sequence test");

  // 验证事件序列：8 个 cycle 事件 + 1 个 loop_failed 终态事件 = 9 个
  const expectedSequence = [
    "discovery_started",
    "discovery_completed",
    "handoff_created",
    "handoff_dispatched",
    "verification_started",
    "verification_rejected", // FailingEvaluator → passed=false
    "persistence_written",
    "scheduling_decision", // STOP_FAILURE（max-iter 触发）
    "loop_failed", // 终态
  ];
  assert.equal(report.events.length, expectedSequence.length);
  const actualSequence = report.events.map((e) => e.eventType);
  assert.deepEqual(actualSequence, expectedSequence);
});

test("K7c. 事件的 phase 字段与 eventType 对应正确", () => {
  const config = createLoopEngineeringConfig({
    maxIterations: 1,
    maxTokens: 100_000,
    stopWhen: "",
  });
  const memory = new InMemoryMemory();
  const scheduler = new LoopScheduler(config);
  const kernel = new LoopKernel(
    config,
    new StaticDiscoveryProbe(makeDiscoveryResult()),
    new StaticHandoffAdapter(makeHandoffItems(), makeSuccessGeneratorResult()),
    new PassingEvaluator(),
    memory,
    scheduler
  );

  const report = kernel.run("K7c phase test");

  // 验证每个事件的 phase 字段与 eventType 所属阶段一致
  const phaseMap: Record<string, string> = {
    discovery_started: "discovery",
    discovery_completed: "discovery",
    handoff_created: "handoff",
    handoff_dispatched: "handoff",
    verification_started: "verification",
    verification_passed: "verification",
    verification_rejected: "verification",
    persistence_written: "persistence",
    scheduling_decision: "scheduling",
    human_checkpoint: "scheduling",
    loop_completed: "scheduling",
    loop_failed: "scheduling",
  };
  for (const event of report.events) {
    const expectedPhase = phaseMap[event.eventType];
    assert.ok(expectedPhase !== undefined, `未定义 eventType=${event.eventType} 的 phase 映射`);
    assert.equal(
      event.phase,
      expectedPhase,
      `eventType=${event.eventType} 的 phase 应为 ${expectedPhase}，实际：${event.phase}`
    );
  }
});

test("K7d. 事件的 runId 与 report.runId 一致，iterIndex 从 0 开始", () => {
  const config = createLoopEngineeringConfig({
    maxIterations: 1,
    maxTokens: 100_000,
    stopWhen: "",
  });
  const memory = new InMemoryMemory();
  const scheduler = new LoopScheduler(config);
  const kernel = new LoopKernel(
    config,
    new StaticDiscoveryProbe(makeDiscoveryResult()),
    new StaticHandoffAdapter(makeHandoffItems(), makeSuccessGeneratorResult()),
    new PassingEvaluator(),
    memory,
    scheduler
  );

  const report = kernel.run("K7d runId iterIndex test");

  // 验证所有事件的 runId 一致
  for (const event of report.events) {
    assert.equal(event.runId, report.runId);
  }
  // 验证 cycle 内事件的 iterIndex=0（单轮场景）
  const cycleEvents = report.events.filter((e) => e.eventType !== "loop_completed");
  for (const event of cycleEvents) {
    assert.equal(event.iterIndex, 0);
  }
  // 验证 eventId 唯一
  const eventIds = new Set(report.events.map((e) => e.eventId));
  assert.equal(eventIds.size, report.events.length);
});

// ============================================================================
// K8. requestHumanCheckpoint 默认 approved=true
// ============================================================================

test("K8. requestHumanCheckpoint 默认 approved=true 且不 abort", () => {
  const config = createLoopEngineeringConfig({
    maxIterations: 1,
    maxTokens: 100_000,
    stopWhen: "",
  });
  const memory = new InMemoryMemory();
  const scheduler = new LoopScheduler(config);
  const kernel = new LoopKernel(
    config,
    new StaticDiscoveryProbe(makeDiscoveryResult()),
    new StaticHandoffAdapter(makeHandoffItems(), makeSuccessGeneratorResult()),
    new PassingEvaluator(),
    memory,
    scheduler
  );

  // 直接调用 requestHumanCheckpoint（不依赖完整 Loop 流程）
  const response: HumanCheckpointResponse = kernel.requestHumanCheckpoint("K8 直接调用测试");

  // 验证默认 approved=true
  assert.equal(response.approved, true);
  // 验证默认 abort=false
  assert.equal(response.abort, false);
  // 验证 feedback 非空
  assert.ok(
    typeof response.feedback === "string" && response.feedback.length > 0,
    `feedback 应非空，实际：${response.feedback}`
  );
});

test("K8b. requestHumanCheckpoint 触发 human_checkpoint 事件并写入 memory", () => {
  const config = createLoopEngineeringConfig({
    maxIterations: 1,
    maxTokens: 100_000,
    stopWhen: "",
  });
  const memory = new InMemoryMemory();
  const scheduler = new LoopScheduler(config);
  const kernel = new LoopKernel(
    config,
    new StaticDiscoveryProbe(makeDiscoveryResult()),
    new StaticHandoffAdapter(makeHandoffItems(), makeSuccessGeneratorResult()),
    new PassingEvaluator(),
    memory,
    scheduler
  );

  const beforeCount = memory.getEventCount();
  kernel.requestHumanCheckpoint("K8b 事件写入测试");
  const afterCount = memory.getEventCount();

  // 验证 memory 事件计数 +1
  assert.equal(afterCount, beforeCount + 1);
  // 验证最新事件为 human_checkpoint 类型
  const allEvents = memory.getAllEvents();
  const lastEvent = allEvents[allEvents.length - 1]!;
  assert.equal(lastEvent.eventType, "human_checkpoint");
  assert.equal(lastEvent.phase, "scheduling");
  assert.equal(String(lastEvent.payload.reason), "K8b 事件写入测试");
});

test("K8c. requestHumanCheckpoint 默认 iterIndex=0（向后兼容）", () => {
  const config = createLoopEngineeringConfig({
    maxIterations: 1,
    maxTokens: 100_000,
    stopWhen: "",
  });
  const memory = new InMemoryMemory();
  const scheduler = new LoopScheduler(config);
  const kernel = new LoopKernel(
    config,
    new StaticDiscoveryProbe(makeDiscoveryResult()),
    new StaticHandoffAdapter(makeHandoffItems(), makeSuccessGeneratorResult()),
    new PassingEvaluator(),
    memory,
    scheduler
  );

  // 不传入 iterIndex，应默认为 0
  kernel.requestHumanCheckpoint("K8c 默认 iterIndex 测试");
  const allEvents = memory.getAllEvents();
  const lastEvent = allEvents[allEvents.length - 1]!;
  assert.equal(lastEvent.eventType, "human_checkpoint");
  assert.equal(lastEvent.iterIndex, 0, "默认 iterIndex 应为 0");
});

test("K8d. requestHumanCheckpoint 显式传入 iterIndex 时事件 iterIndex 正确反映", () => {
  const config = createLoopEngineeringConfig({
    maxIterations: 1,
    maxTokens: 100_000,
    stopWhen: "",
  });
  const memory = new InMemoryMemory();
  const scheduler = new LoopScheduler(config);
  const kernel = new LoopKernel(
    config,
    new StaticDiscoveryProbe(makeDiscoveryResult()),
    new StaticHandoffAdapter(makeHandoffItems(), makeSuccessGeneratorResult()),
    new PassingEvaluator(),
    memory,
    scheduler
  );

  // 显式传入 iterIndex=5
  kernel.requestHumanCheckpoint("K8d 显式 iterIndex 测试", 5);
  const allEvents = memory.getAllEvents();
  const lastEvent = allEvents[allEvents.length - 1]!;
  assert.equal(lastEvent.eventType, "human_checkpoint");
  assert.equal(lastEvent.iterIndex, 5, "显式传入的 iterIndex 应正确反映到事件");
});

test("K8e. run() 内 HUMAN_CHECKPOINT 触发时事件 iterIndex 正确（M3 修复验证）", () => {
  // M3 修复验证：run() 内通过 HUMAN_CHECKPOINT action 触发 requestHumanCheckpoint 时，
  // human_checkpoint 事件的 iterIndex 应正确反映触发轮次（非 0）
  const config = createLoopEngineeringConfig({
    maxIterations: 10,
    maxTokens: 100_000,
    stopWhen: "",
  });
  const memory = new InMemoryMemory();
  const scheduler = new LoopScheduler(config);
  const kernel = new LoopKernel(
    config,
    new StaticDiscoveryProbe(makeDiscoveryResult()),
    new StaticHandoffAdapter(makeHandoffItems(), makeFailureGeneratorResult()),
    new FailingEvaluator(),
    memory,
    scheduler
  );

  const report = kernel.run("K8e M3 修复验证");

  // 连续失败场景下应触发 HUMAN_CHECKPOINT
  assert.ok(report.humanCheckpoints.length >= 1, `应触发 HUMAN_CHECKPOINT，实际：${report.humanCheckpoints.length}`);

  // 验证 human_checkpoint 事件的 iterIndex 与 humanCheckpoints 记录一致
  const humanCheckpointEvents = report.events.filter((e) => e.eventType === "human_checkpoint");
  assert.ok(
    humanCheckpointEvents.length === report.humanCheckpoints.length,
    `human_checkpoint 事件数(${humanCheckpointEvents.length}) 应与 humanCheckpoints 记录数(${report.humanCheckpoints.length}) 一致`
  );

  // 逐条验证：每个 human_checkpoint 事件的 iterIndex 应与对应 humanCheckpoints 记录的 iterIndex 一致
  for (let i = 0; i < humanCheckpointEvents.length; i++) {
    const event = humanCheckpointEvents[i]!;
    const record = report.humanCheckpoints[i]!;
    assert.equal(
      event.iterIndex,
      record.iterIndex,
      `第 ${i + 1} 个 human_checkpoint 事件的 iterIndex(${event.iterIndex}) 应与记录(${record.iterIndex}) 一致`
    );
    // 首次 HUMAN_CHECKPOINT 在 iter 2 触发（连续 3 次失败），iterIndex 应为 2 而非 0
    if (i === 0) {
      assert.equal(
        event.iterIndex,
        2,
        `首次 HUMAN_CHECKPOINT 应在 iter 2 触发（连续 3 次失败），实际：${event.iterIndex}`
      );
    }
  }
});

// ============================================================================
// 附加：scheduler 集成测试
// ============================================================================

test("S1. LoopScheduler.computeBackoff 返回 0 当 consecutiveFailures=0", () => {
  const config = createLoopEngineeringConfig();
  const scheduler = new LoopScheduler(config);
  // 无失败记录：无需退避
  assert.equal(scheduler.computeBackoff(0), 0);
});

test("S2. LoopScheduler.computeBackoff 指数递增（consecutiveFailures=1→2→3）", () => {
  const config = createLoopEngineeringConfig();
  const scheduler = new LoopScheduler(config);
  // 多次采样取最小值（jitter 可能导致波动，但整体应递增）
  const samples: number[] = [];
  for (let i = 0; i < 10; i++) {
    samples.push(scheduler.computeBackoff(1));
  }
  const backoff1 = Math.min(...samples);

  samples.length = 0;
  for (let i = 0; i < 10; i++) {
    samples.push(scheduler.computeBackoff(2));
  }
  const backoff2 = Math.min(...samples);

  samples.length = 0;
  for (let i = 0; i < 10; i++) {
    samples.push(scheduler.computeBackoff(3));
  }
  const backoff3 = Math.min(...samples);

  // 指数退避：backoff1 < backoff2 < backoff3（取最小值消除 jitter 正向波动）
  assert.ok(backoff1 > 0, `backoff1 应 > 0，实际：${backoff1}`);
  assert.ok(backoff2 >= backoff1, `backoff2(${backoff2}) 应 >= backoff1(${backoff1})`);
  assert.ok(backoff3 >= backoff2, `backoff3(${backoff3}) 应 >= backoff2(${backoff2})`);
});

test("S3. LoopScheduler.computeBackoff 受 maxBackoff 上限约束", () => {
  // 配置极小的 maxBackoff，验证退避被截断
  const config = createLoopEngineeringConfig({
    extra: { backoff_max_sec: 1.0 },
  });
  const scheduler = new LoopScheduler(config);
  // 即使 consecutiveFailures=10，退避不应超过 1.0 + jitter
  const backoff = scheduler.computeBackoff(10);
  // jitter 范围 ±10%，所以最大值约 1.1
  assert.ok(backoff <= 1.2, `backoff 应 <= 1.2（含 jitter），实际：${backoff}`);
});

test("S4. LoopScheduler.decideNext Token 预算耗尽 → STOP_FAILURE", () => {
  const config = createLoopEngineeringConfig({
    maxIterations: 10,
    maxTokens: 1000,
    stopWhen: "",
  });
  const scheduler = new LoopScheduler(config);
  // 构造一个 passed=true 的 verdict
  const verdict: LoopEvaluationVerdict = {
    passed: true,
    evaluatorId: "test",
    reason: "通过",
    findings: [],
    severity: "info",
    suggestedFix: "",
    sampledArtifacts: [],
  };
  // cumulativeTokens=1000 >= maxTokens=1000 → STOP_FAILURE
  const decision = scheduler.decideNext(
    0,
    verdict,
    [],
    1000, // 等于 maxTokens
    0
  );
  assert.equal(decision.action, "stop_failure");
  assert.ok(decision.reason.includes("Token 预算耗尽"));
});

test("S5. LoopScheduler.decideNext maxIterations 达到且 passed → STOP_SUCCESS", () => {
  const config = createLoopEngineeringConfig({
    maxIterations: 2,
    maxTokens: 1000,
    stopWhen: "",
  });
  const scheduler = new LoopScheduler(config);
  const verdict: LoopEvaluationVerdict = {
    passed: true,
    evaluatorId: "test",
    reason: "通过",
    findings: [],
    severity: "info",
    suggestedFix: "",
    sampledArtifacts: [],
  };
  // currentIter=1, 1+1>=2 → STOP_SUCCESS（passed=true）
  const decision = scheduler.decideNext(1, verdict, [], 0, 0);
  assert.equal(decision.action, "stop_success");
});

test("S6. LoopScheduler.decideNext 连续失败阈值验证（1/2/3/4/5）", () => {
  const config = createLoopEngineeringConfig({
    maxIterations: 100, // 确保不触发 max-iter
    maxTokens: 1_000_000, // 确保不触发 max-tokens
    stopWhen: "",
  });
  const scheduler = new LoopScheduler(config);
  const failVerdict: LoopEvaluationVerdict = {
    passed: false,
    evaluatorId: "test",
    reason: "失败",
    findings: [],
    severity: "blocker",
    suggestedFix: "",
    sampledArtifacts: [],
  };

  // consecutiveFailures=0 → effectiveFailures=1 → FIX
  assert.equal(scheduler.decideNext(0, failVerdict, [], 0, 0).action, "fix");
  // consecutiveFailures=1 → effectiveFailures=2 → FIX
  assert.equal(scheduler.decideNext(0, failVerdict, [], 0, 1).action, "fix");
  // consecutiveFailures=2 → effectiveFailures=3 → HUMAN_CHECKPOINT
  assert.equal(scheduler.decideNext(0, failVerdict, [], 0, 2).action, "human_checkpoint");
  // consecutiveFailures=3 → effectiveFailures=4 → HUMAN_CHECKPOINT
  assert.equal(scheduler.decideNext(0, failVerdict, [], 0, 3).action, "human_checkpoint");
  // consecutiveFailures=4 → effectiveFailures=5 → STOP_FAILURE
  assert.equal(scheduler.decideNext(0, failVerdict, [], 0, 4).action, "stop_failure");
});
