/**
 * EAG-P3 批次 10 单元测试拆分文件 4/5：不可变性 + 错误类
 *
 * 拆分来源：eag-testing-orchestrator.test.ts
 * 包含测试用例前缀：T14 + T15
 *
 * 测试范围：
 * - T14. 不可变性
 *   - T14a. TestingLoopResult 冻结
 *   - T14b. contractTests 数组冻结
 *   - T14c. e2eTests 数组冻结
 *   - T14d. events 数组冻结
 *   - T14e. integrationTests 数组冻结
 *   - T14f. complianceTests 数组冻结
 * - T15. 错误类
 *   - T15a. TestingOrchestratorError 含 kind 属性
 *   - T15b. TestingOrchestratorError 含 cause 属性
 *   - T15c. TestingOrchestratorError name 属性
 *   - T15d. TestingOrchestratorError 全部 kind 值覆盖
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止 mock，使用 InMemoryLLMClient 真实实现 + InMemoryPkcAccessor 真实实现 + LoopGuard 真实实现
 * - 使用真实 fs I/O（mkdtempSync + try/finally 清理）
 *
 * @module core/tests/eag-testing-orch-immutability-errors
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { TestingOrchestrator, TestingOrchestratorError } from "../eag/testing/testing-orchestrator";
import type { TestingOrchestratorErrorKind } from "../eag/testing/testing-orchestrator";
// EAG-P3 批次 11 S1 改造：注入独立 GateG6Checker / GateG7Checker（构造期必填）
import { GateG6Checker } from "../eag/gate/gate-g6-checker";
import { GateG7Checker } from "../eag/gate/gate-g7-checker";
import { CoverageGate } from "../eag/testing/coverage-gate";
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
// T14. 不可变性
// ============================================================================

test("T14a: TestingLoopResult 冻结", async () => {
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
    assert.ok(Object.isFrozen(result), "TestingLoopResult 应冻结");
  } finally {
    cleanupTmpDir(projectRoot);
  }
});

test("T14b: contractTests 数组冻结", async () => {
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
    assert.ok(Object.isFrozen(result.contractTests), "contractTests 数组应冻结");
  } finally {
    cleanupTmpDir(projectRoot);
  }
});

test("T14c: e2eTests 数组冻结", async () => {
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
    assert.ok(Object.isFrozen(result.e2eTests), "e2eTests 数组应冻结");
  } finally {
    cleanupTmpDir(projectRoot);
  }
});

test("T14d: events 数组冻结", async () => {
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
    assert.ok(Object.isFrozen(result.events), "events 数组应冻结");
  } finally {
    cleanupTmpDir(projectRoot);
  }
});

test("T14e: integrationTests 数组冻结", async () => {
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
    assert.ok(Object.isFrozen(result.integrationTests), "integrationTests 数组应冻结");
  } finally {
    cleanupTmpDir(projectRoot);
  }
});

test("T14f: complianceTests 数组冻结", async () => {
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
    assert.ok(Object.isFrozen(result.complianceTests), "complianceTests 数组应冻结");
  } finally {
    cleanupTmpDir(projectRoot);
  }
});

// ============================================================================
// T15. 错误类
// ============================================================================

test("T15a: TestingOrchestratorError 含 kind 属性", () => {
  const error = new TestingOrchestratorError("request-invalid", "测试错误消息");
  assert.ok(error instanceof TestingOrchestratorError);
  assert.equal(error.kind, "request-invalid");
  assert.equal(error.message, "测试错误消息");
});

test("T15b: TestingOrchestratorError 含 cause 属性", () => {
  const cause = new Error("原始错误");
  const error = new TestingOrchestratorError("generator-failed", "生成器失败", cause);
  assert.ok(error instanceof TestingOrchestratorError);
  assert.equal(error.kind, "generator-failed");
  assert.equal(error.cause, cause);
});

test("T15c: TestingOrchestratorError name 属性", () => {
  const error = new TestingOrchestratorError("gate-failed", "门禁失败");
  assert.equal(error.name, "TestingOrchestratorError");
});

test("T15d: TestingOrchestratorError 全部 kind 值覆盖", () => {
  // 验证 TestingOrchestratorErrorKind 联合类型的全部合法值
  const kinds: TestingOrchestratorErrorKind[] = [
    "request-invalid",
    "gate-failed",
    "generator-failed",
    "coverage-failed",
    "contract-broken",
  ];
  for (const kind of kinds) {
    const error = new TestingOrchestratorError(kind, `测试 ${kind}`);
    assert.equal(error.kind, kind, `kind=${kind} 应被正确设置`);
    assert.equal(error.name, "TestingOrchestratorError");
  }
});
