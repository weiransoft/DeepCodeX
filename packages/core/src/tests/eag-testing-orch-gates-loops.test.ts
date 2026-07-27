/**
 * EAG-P3 批次 10 单元测试拆分文件 2/5：门禁 + LoopGuard + 测试生成阶段
 *
 * 拆分来源：eag-testing-orchestrator.test.ts
 * 包含测试用例前缀：T4 + T5 + T6 + T7 + T8 + T9
 *
 * 测试范围：
 * - T4. G-6 门禁检查（默认通过）
 * - T5. LoopGuard 上限保护触发
 * - T6. 契约测试生成阶段
 * - T7. E2E 测试生成阶段
 * - T8. 既有契约保护判定
 * - T9. 测试质量静态判定
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止 mock，使用 InMemoryLLMClient 真实实现 + InMemoryPkcAccessor 真实实现 + LoopGuard 真实实现
 * - 使用真实 fs I/O（mkdtempSync + try/finally 清理）
 *
 * @module core/tests/eag-testing-orch-gates-loops
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { TestingOrchestrator } from "../eag/testing/testing-orchestrator";
// EAG-P3 批次 11 S1 改造：注入独立 GateG6Checker / GateG7Checker（构造期必填）
import { GateG6Checker } from "../eag/gate/gate-g6-checker";
import { GateG7Checker } from "../eag/gate/gate-g7-checker";
import { CoverageGate } from "../eag/testing/coverage-gate";
import { InMemoryLLMClient } from "../eag/coding/llm-filler";
import { LoopGuard } from "../common/loop-guard";
import {
  InMemoryPkcAccessor,
  createE2eTestSpec,
  createTaskDag,
  createTestingLoopRequest,
  createTmpProjectDir,
  cleanupTmpDir,
  setupProjectStructure,
  realE2eTestResponseGenerator,
  unifiedRealResponseGenerator,
} from "./fixtures/eag-testing-orch-fixtures";

// ============================================================================
// T4. G-6 门禁检查（默认通过）
// ============================================================================

/**
 * G-6 门禁检查是 TESTING Loop 的进入门禁，编排器内部默认构造 g5Passed=true /
 * unitTestsPassed=true / specStatus=approved 的上下文，因此默认情况下 G-6 应通过。
 *
 * 由于 G-6 默认通过，此测试通过观察后续阶段是否被执行来间接验证。
 */
test("T4a: G-6 默认通过（间接验证：后续阶段被执行）", async () => {
  const projectRoot = createTmpProjectDir();
  try {
    setupProjectStructure(projectRoot);

    const pkcAccessor = new InMemoryPkcAccessor([createE2eTestSpec()], []);
    const coverageGate = new CoverageGate(pkcAccessor);
    const orchestrator = new TestingOrchestrator({
      coverageGate,
      gateG6Checker: new GateG6Checker(),
      gateG7Checker: new GateG7Checker(),
    });

    const request = createTestingLoopRequest({
      projectRoot,
      llmClient: new InMemoryLLMClient(unifiedRealResponseGenerator),
    });

    const result = await orchestrator.run(request);
    // G-6 通过后，编排器应进入契约测试生成阶段
    // 由于 c8 不可用，最终会进入 human_checkpoint，但应记录事件流
    assert.ok(result.events.length > 0, "应有事件流产出");

    // 验证 G-6 通过事件存在（verification_passed 含 gateId="G-6"）
    const g6PassedEvent = result.events.find(
      (e) => e.eventType === "verification_passed" && (e.payload as Record<string, unknown>).gateId === "G-6"
    );
    assert.ok(g6PassedEvent, "应含 G-6 通过事件");
  } finally {
    cleanupTmpDir(projectRoot);
  }
});

// ============================================================================
// T5. LoopGuard 上限保护触发
// ============================================================================

test("T5a: LoopGuard 已 abort → finalStatus=stop_failure", async () => {
  const projectRoot = createTmpProjectDir();
  try {
    setupProjectStructure(projectRoot);

    const pkcAccessor = new InMemoryPkcAccessor([createE2eTestSpec()], []);
    const coverageGate = new CoverageGate(pkcAccessor);
    const orchestrator = new TestingOrchestrator({
      coverageGate,
      gateG6Checker: new GateG6Checker(),
      gateG7Checker: new GateG7Checker(),
    });

    // 构造已 abort 的 LoopGuard
    const loopGuard = new LoopGuard({ maxIterations: 5, maxTokens: 100_000 });
    loopGuard.abort();

    const request = createTestingLoopRequest({
      projectRoot,
      loopGuard,
    });

    const result = await orchestrator.run(request);
    assert.equal(result.finalStatus, "stop_failure", "LoopGuard abort 应触发 stop_failure");
    assert.ok(result.blockedReason, "应有阻塞原因");
    assert.ok(result.blockedReason!.includes("LoopGuard"), "阻塞原因应含 LoopGuard");

    // 验证事件流含 loop_failed 事件
    const loopFailedEvent = result.events.find((e) => e.eventType === "loop_failed");
    assert.ok(loopFailedEvent, "应含 loop_failed 事件");
  } finally {
    cleanupTmpDir(projectRoot);
  }
});

// ============================================================================
// T6. 契约测试生成阶段
// ============================================================================

test("T6a: taskDag.nodes 为空 → contractTests 为空", async () => {
  const projectRoot = createTmpProjectDir();
  try {
    setupProjectStructure(projectRoot);

    const pkcAccessor = new InMemoryPkcAccessor([createE2eTestSpec()], []);
    const coverageGate = new CoverageGate(pkcAccessor);
    const orchestrator = new TestingOrchestrator({
      coverageGate,
      gateG6Checker: new GateG6Checker(),
      gateG7Checker: new GateG7Checker(),
    });

    const request = createTestingLoopRequest({
      projectRoot,
      taskDag: { nodes: [], topologicalOrder: [] },
    });

    const result = await orchestrator.run(request);
    assert.equal(result.contractTests.length, 0, "taskDag 为空时契约测试应为空");

    // 由于 c8 不可用，最终会进入 human_checkpoint
    assert.equal(result.finalStatus, "human_checkpoint", "c8 不可用时应进入 human_checkpoint");
  } finally {
    cleanupTmpDir(projectRoot);
  }
});

test("T6b: taskDag.nodes 含任务 → contractTests 非空", async () => {
  const projectRoot = createTmpProjectDir();
  try {
    setupProjectStructure(projectRoot);

    const pkcAccessor = new InMemoryPkcAccessor([createE2eTestSpec()], []);
    const coverageGate = new CoverageGate(pkcAccessor);
    const orchestrator = new TestingOrchestrator({
      coverageGate,
      gateG6Checker: new GateG6Checker(),
      gateG7Checker: new GateG7Checker(),
    });

    const request = createTestingLoopRequest({
      projectRoot,
      taskDag: createTaskDag(2),
      llmClient: new InMemoryLLMClient(unifiedRealResponseGenerator),
    });

    const result = await orchestrator.run(request);
    // taskDag 含 2 个任务，应生成 2 个契约测试文件
    assert.ok(result.contractTests.length > 0, "taskDag 含任务时应生成契约测试");
    assert.equal(result.contractTests.length, 2, "应生成 2 个契约测试文件（对应 2 个任务节点）");

    // 验证契约测试类型
    for (const test of result.contractTests) {
      assert.equal(test.kind, "contract", "测试文件类型应为 contract");
    }
  } finally {
    cleanupTmpDir(projectRoot);
  }
});

// ============================================================================
// T7. E2E 测试生成阶段
// ============================================================================

test("T7a: PKC 返回 documented 流程 → 生成 E2E 测试", async () => {
  const projectRoot = createTmpProjectDir();
  try {
    setupProjectStructure(projectRoot);

    // 注入 documented 流程
    const pkcAccessor = new InMemoryPkcAccessor([createE2eTestSpec()], []);
    const coverageGate = new CoverageGate(pkcAccessor);
    const orchestrator = new TestingOrchestrator({
      coverageGate,
      gateG6Checker: new GateG6Checker(),
      gateG7Checker: new GateG7Checker(),
    });

    const request = createTestingLoopRequest({
      projectRoot,
      pkcAccessor,
      llmClient: new InMemoryLLMClient(realE2eTestResponseGenerator),
    });

    const result = await orchestrator.run(request);
    // documented 流程应被接受并生成 E2E 测试
    assert.ok(result.e2eTests.length > 0, "documented 流程应生成 E2E 测试");

    // 验证 E2E 测试类型
    for (const test of result.e2eTests) {
      assert.equal(test.kind, "e2e", "测试文件类型应为 e2e");
    }
  } finally {
    cleanupTmpDir(projectRoot);
  }
});

test("T7b: PKC 返回 inferred 流程 → humanCheckpointFlows 非空（事件流记录）", async () => {
  const projectRoot = createTmpProjectDir();
  try {
    setupProjectStructure(projectRoot);

    // 注入 inferred 流程（需转 HUMAN_CHECKPOINT 队列）
    const inferredFlow = createE2eTestSpec({
      flowId: "flow-inferred",
      flowName: "推断流程",
      confidence: "inferred",
    });
    const pkcAccessor = new InMemoryPkcAccessor([inferredFlow], []);
    const coverageGate = new CoverageGate(pkcAccessor);
    const orchestrator = new TestingOrchestrator({
      coverageGate,
      gateG6Checker: new GateG6Checker(),
      gateG7Checker: new GateG7Checker(),
    });

    const request = createTestingLoopRequest({
      projectRoot,
      pkcAccessor,
      llmClient: new InMemoryLLMClient(realE2eTestResponseGenerator),
    });

    const result = await orchestrator.run(request);
    // inferred 流程应触发 human_checkpoint 事件
    const humanCheckpointEvent = result.events.find(
      (e) =>
        e.eventType === "human_checkpoint" &&
        (e.payload as Record<string, unknown>).reason === "inferred-flows-pending-confirmation"
    );
    assert.ok(humanCheckpointEvent, "inferred 流程应触发 human_checkpoint 事件");
    assert.ok(
      ((humanCheckpointEvent!.payload as Record<string, unknown>).flowCount as number) > 0,
      "human_checkpoint 事件应记录 flowCount > 0"
    );
  } finally {
    cleanupTmpDir(projectRoot);
  }
});

// ============================================================================
// T8. 既有契约保护判定
// ============================================================================

test("T8a: 默认场景（既有契约文件不存在）→ 降级跳过（不阻断 Loop）", async () => {
  const projectRoot = createTmpProjectDir();
  try {
    setupProjectStructure(projectRoot);

    // 不创建 .eag/existing-contracts.json 文件 → BrownfieldContractGuard.check() 抛错
    // 编排器应捕获错误并降级跳过，不阻断 Loop
    const pkcAccessor = new InMemoryPkcAccessor([createE2eTestSpec()], []);
    const coverageGate = new CoverageGate(pkcAccessor);
    const orchestrator = new TestingOrchestrator({
      coverageGate,
      gateG6Checker: new GateG6Checker(),
      gateG7Checker: new GateG7Checker(),
    });

    const request = createTestingLoopRequest({
      projectRoot,
      llmClient: new InMemoryLLMClient(unifiedRealResponseGenerator),
    });

    const result = await orchestrator.run(request);
    // 既有契约文件不存在时，编排器应降级跳过该阶段，不阻断 Loop
    // 由于 c8 不可用，最终会进入 human_checkpoint（但不是因为契约保护判定失败）
    assert.notEqual(result.finalStatus, "stop_failure", "契约保护判定失败不应导致 stop_failure");

    // 验证事件流含降级跳过事件
    const skippedEvent = result.events.find(
      (e) =>
        e.eventType === "scheduling_decision" &&
        (e.payload as Record<string, unknown>).stage === "brownfield-contract-guard" &&
        (e.payload as Record<string, unknown>).skipped === true
    );
    assert.ok(skippedEvent, "应记录 brownfield-contract-guard 降级跳过事件");
  } finally {
    cleanupTmpDir(projectRoot);
  }
});

// ============================================================================
// T9. 测试质量静态判定
// ============================================================================

test("T9a: 默认注入 3 个 Checker（AssertionDensityChecker / TestNamingChecker / CoverageGapChecker）", async () => {
  const projectRoot = createTmpProjectDir();
  try {
    setupProjectStructure(projectRoot);

    const pkcAccessor = new InMemoryPkcAccessor([createE2eTestSpec()], []);
    const coverageGate = new CoverageGate(pkcAccessor);
    const orchestrator = new TestingOrchestrator({
      coverageGate,
      gateG6Checker: new GateG6Checker(),
      gateG7Checker: new GateG7Checker(),
    });

    const request = createTestingLoopRequest({
      projectRoot,
      llmClient: new InMemoryLLMClient(unifiedRealResponseGenerator),
    });

    const result = await orchestrator.run(request);

    // 验证测试质量静态判定阶段被执行（事件流含 verification_passed 或 scheduling_decision for test-quality-checkers）
    const qualityEvent = result.events.find(
      (e) =>
        (e.eventType === "verification_passed" ||
          e.eventType === "verification_rejected" ||
          e.eventType === "scheduling_decision") &&
        (e.payload as Record<string, unknown>).stage === "test-quality-checkers"
    );
    assert.ok(qualityEvent, "应记录测试质量静态判定阶段事件");
  } finally {
    cleanupTmpDir(projectRoot);
  }
});
