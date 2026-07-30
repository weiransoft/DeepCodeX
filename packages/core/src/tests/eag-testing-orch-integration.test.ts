/**
 * EAG-P3 批次 10 单元测试拆分文件 5/5：默认 staticCheckers + 完整流程集成 + 自动 runId
 *
 * 拆分来源：eag-testing-orchestrator.test.ts
 * 包含测试用例前缀：T16 + T17 + T18
 *
 * 测试范围：
 * - T16. 默认 staticCheckers 验证
 *   - T16a. 默认注入 3 个 staticCheckers（DEFAULT_TEST_QUALITY_CHECKERS）
 * - T17. 完整流程集成测试（c8 不可用环境）
 *   - T17a. 完整流程集成测试（c8 不可用 → human_checkpoint）
 * - T18. 自动生成 runId
 *   - T18a. 未提供 runId → 自动生成 runId
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止 mock，使用 InMemoryLLMClient 真实实现 + InMemoryPkcAccessor 真实实现 + LoopGuard 真实实现
 * - 使用真实 fs I/O（mkdtempSync + try/finally 清理）
 *
 * @module core/tests/eag-testing-orch-integration
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { TestingOrchestrator } from "../eag/testing/testing-orchestrator";
// EAG-P3 批次 11 S1 改造：注入独立 GateG6Checker / GateG7Checker（构造期必填）
import { GateG6Checker } from "../eag/gate/gate-g6-checker";
import { GateG7Checker } from "../eag/gate/gate-g7-checker";
import { CoverageGate } from "../eag/testing/coverage-gate";
import { DEFAULT_TEST_QUALITY_CHECKERS } from "../eag/testing/static-checkers/index";
import { InMemoryLLMClient } from "../eag/coding/llm-filler";
import {
  InMemoryPkcAccessor,
  createE2eTestSpec,
  createTaskDag,
  createTestingLoopRequest,
  createTmpProjectDir,
  cleanupTmpDir,
  setupProjectStructure,
  unifiedRealResponseGenerator,
} from "./fixtures/eag-testing-orch-fixtures";

// ============================================================================
// T16. 默认 staticCheckers 验证
// ============================================================================

test("T16a: 默认注入 3 个 staticCheckers（DEFAULT_TEST_QUALITY_CHECKERS）", () => {
  // 验证 DEFAULT_TEST_QUALITY_CHECKERS 含 3 个 Checker
  assert.equal(DEFAULT_TEST_QUALITY_CHECKERS.size, 3, "DEFAULT_TEST_QUALITY_CHECKERS 应含 3 个 Checker");
  assert.ok(DEFAULT_TEST_QUALITY_CHECKERS.has("assertion-density"), "应含 assertion-density Checker");
  assert.ok(DEFAULT_TEST_QUALITY_CHECKERS.has("test-naming"), "应含 test-naming Checker");
  assert.ok(DEFAULT_TEST_QUALITY_CHECKERS.has("coverage-gap"), "应含 coverage-gap Checker");
});

// ============================================================================
// T17. 完整流程集成测试（c8 不可用环境）
// ============================================================================

/**
 * 完整 TESTING Loop 流程集成测试
 *
 * 在 c8 不可用环境下，编排器应完成以下阶段：
 * 1. G-6 门禁检查通过
 * 2. LoopGuard 检查通过
 * 3. 契约测试生成成功
 * 4. E2E 测试生成成功
 * 5. 既有契约保护判定降级跳过（文件不存在）
 * 6. 测试质量静态判定执行
 * 7. 覆盖率门禁失败（c8 不可用）→ finalStatus=human_checkpoint
 *
 * 验证产出物的完整性：
 * - runId 非空
 * - finalStatus=human_checkpoint
 * - blockedReason 含"覆盖率门禁"
 * - contractTests 非空
 * - e2eTests 非空
 * - events 数组非空（含全部阶段事件）
 * - durationSec >= 0
 */
test("T17a: 完整流程集成测试（c8 不可用 → human_checkpoint）", async () => {
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
      runId: "test-run-001",
    });

    const result = await orchestrator.run(request);

    // 验证 runId
    assert.equal(result.runId, "test-run-001", "runId 应与请求一致");

    // 验证 finalStatus
    assert.equal(result.finalStatus, "human_checkpoint", "c8 不可用时应进入 human_checkpoint");

    // 验证 blockedReason
    assert.ok(result.blockedReason!.includes("覆盖率门禁"), "blockedReason 应含'覆盖率门禁'");

    // 验证产出物完整性
    assert.ok(result.contractTests.length > 0, "应生成契约测试文件");
    assert.ok(result.e2eTests.length > 0, "应生成 E2E 测试文件");

    // 验证事件流完整性
    assert.ok(result.events.length > 0, "应有事件流产出");

    // 验证事件流含 G-6 通过事件
    const g6PassedEvent = result.events.find(
      (e) => e.eventType === "verification_passed" && (e.payload as Record<string, unknown>).gateId === "G-6"
    );
    assert.ok(g6PassedEvent, "应含 G-6 通过事件");

    // 验证事件流含契约测试生成完成事件
    const contractGenEvent = result.events.find(
      (e) =>
        e.eventType === "discovery_completed" &&
        (e.payload as Record<string, unknown>).stage === "contract-test-generation"
    );
    assert.ok(contractGenEvent, "应含契约测试生成完成事件");

    // 验证事件流含 E2E 测试生成完成事件
    const e2eGenEvent = result.events.find(
      (e) =>
        e.eventType === "handoff_dispatched" && (e.payload as Record<string, unknown>).stage === "e2e-test-generation"
    );
    assert.ok(e2eGenEvent, "应含 E2E 测试生成完成事件");

    // 验证 durationSec
    assert.ok(result.durationSec >= 0, "durationSec 应 ≥ 0");

    // 验证 totalLlmCallCount
    assert.ok(result.totalLlmCallCount >= 0, "totalLlmCallCount 应 ≥ 0");

    // 验证 totalTokensUsed
    assert.ok(result.totalTokensUsed >= 0, "totalTokensUsed 应 ≥ 0");
  } finally {
    cleanupTmpDir(projectRoot);
  }
});

// ============================================================================
// T18. 自动生成 runId
// ============================================================================

test("T18a: 未提供 runId → 自动生成 runId", async () => {
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
      // 不提供 runId，编排器应自动生成
    });
    // 删除 runId 字段

    const requestWithoutRunId = { ...request } as any;
    delete requestWithoutRunId.runId;

    const result = await orchestrator.run(requestWithoutRunId);
    // 应自动生成 runId（16 字符 SHA256 哈希）
    assert.ok(result.runId, "应自动生成 runId");
    assert.equal(result.runId.length, 16, "自动生成的 runId 应为 16 字符");
  } finally {
    cleanupTmpDir(projectRoot);
  }
});
