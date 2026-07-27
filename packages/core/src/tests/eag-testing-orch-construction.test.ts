/**
 * EAG-P3 批次 10 单元测试拆分文件 1/5：实例化 + 构造校验 + 请求校验
 *
 * 拆分来源：eag-testing-orchestrator.test.ts
 * 包含测试用例前缀：T1 + T2 + T3
 *
 * 测试范围：
 * - T1. TestingOrchestrator 实例化
 *   - T1a. 默认构造 → 实例化成功
 *   - T1b. 注入 logger → 实例化成功
 *   - T1c. createDefaultTestingOrchestrator 工厂函数
 * - T2. 构造函数校验
 *   - T2a. coverageGate 缺失 → 抛 TestingOrchestratorError (request-invalid)
 *   - T2b. gateG6Checker 缺失 → 抛 TestingOrchestratorError (request-invalid)
 *   - T2c. gateG7Checker 缺失 → 抛 TestingOrchestratorError (request-invalid)
 * - T3. run() 请求校验失败路径
 *   - T3a. projectRoot 空 → 抛 TestingOrchestratorError (request-invalid)
 *   - T3b. specContent 空 → 抛 TestingOrchestratorError (request-invalid)
 *   - T3c. planContent 空 → 抛 TestingOrchestratorError (request-invalid)
 *   - T3d. tasksContent 空 → 抛 TestingOrchestratorError (request-invalid)
 *   - T3f. taskDag 非对象 → 抛 TestingOrchestratorError (request-invalid)
 *   - T3g. acceptanceCriteria 非数组 → 抛 TestingOrchestratorError (request-invalid)
 *   - T3h. llmClient 缺失 createMessage → 抛 TestingOrchestratorError (request-invalid)
 *   - T3i. pkcAccessor 缺失 queryBusinessFlows → 抛 TestingOrchestratorError (request-invalid)
 *   - T3j. loopGuard 缺失 check → 抛 TestingOrchestratorError (request-invalid)
 *   - T3k. maxIterations < 1 → 抛 TestingOrchestratorError (request-invalid)
 *   - T3l. maxIterations 超上限 → 抛 TestingOrchestratorError (request-invalid)
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止 mock，使用 InMemoryLLMClient 真实实现 + InMemoryPkcAccessor 真实实现 + LoopGuard 真实实现
 * - 使用真实 fs I/O（mkdtempSync + try/finally 清理）
 *
 * @module core/tests/eag-testing-orch-construction
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TestingOrchestrator,
  TestingOrchestratorError,
  createDefaultTestingOrchestrator,
} from "../eag/testing/testing-orchestrator";
// EAG-P3 批次 11 S1 改造：注入独立 GateG6Checker / GateG7Checker（构造期必填）
import { GateG6Checker } from "../eag/gate/gate-g6-checker";
import { GateG7Checker } from "../eag/gate/gate-g7-checker";
import { CoverageGate } from "../eag/testing/coverage-gate";
import { DEFAULT_MAX_TESTING_ITERATIONS } from "../eag/testing/types";
import { InMemoryLLMClient } from "../eag/coding/llm-filler";
import { InMemoryPkcAccessor, createE2eTestSpec, createTestingLoopRequest } from "./fixtures/eag-testing-orch-fixtures";

// ============================================================================
// T1. TestingOrchestrator 实例化
// ============================================================================

test("T1a: 默认构造 → 实例化成功", () => {
  const pkcAccessor = new InMemoryPkcAccessor();
  const coverageGate = new CoverageGate(pkcAccessor);
  const orchestrator = new TestingOrchestrator({
    coverageGate,
    gateG6Checker: new GateG6Checker(),
    gateG7Checker: new GateG7Checker(),
  });
  assert.ok(orchestrator, "应成功实例化");
  assert.equal(typeof orchestrator.run, "function", "应含 run 方法");
});

test("T1b: 注入 logger → 实例化成功", () => {
  const pkcAccessor = new InMemoryPkcAccessor();
  const coverageGate = new CoverageGate(pkcAccessor);
  const logs: Array<{ message: string; level?: string }> = [];
  const logger = (message: string, level?: "info" | "warn" | "error") => {
    logs.push({ message, level });
  };
  const orchestrator = new TestingOrchestrator({
    coverageGate,
    gateG6Checker: new GateG6Checker(),
    gateG7Checker: new GateG7Checker(),
    logger,
  });
  assert.ok(orchestrator, "应成功实例化");
});

test("T1c: createDefaultTestingOrchestrator 工厂函数", () => {
  const pkcAccessor = new InMemoryPkcAccessor();
  const coverageGate = new CoverageGate(pkcAccessor);
  const orchestrator = createDefaultTestingOrchestrator(coverageGate);
  assert.ok(orchestrator instanceof TestingOrchestrator, "应返回 TestingOrchestrator 实例");
});

// ============================================================================
// T2. 构造函数校验
// ============================================================================

test("T2a: coverageGate 缺失 → 抛 TestingOrchestratorError (request-invalid)", () => {
  assert.throws(
    () => new TestingOrchestrator({} as any),
    (err: unknown) => {
      assert.ok(err instanceof TestingOrchestratorError);
      assert.equal((err as TestingOrchestratorError).kind, "request-invalid", "kind 应为 request-invalid");
      assert.ok((err as TestingOrchestratorError).message.includes("coverageGate"), "错误消息应含 coverageGate");
      return true;
    }
  );
});

// EAG-P3 批次 11 S1 改造新增：T2b/T2c 测试 gateG6Checker / gateG7Checker 缺失场景
// 设计依据：EAG-P3 批次 11 设计 §3 S1 D-S1-4——构造期不变式校验（必填检查）

test("T2b: gateG6Checker 缺失 → 抛 TestingOrchestratorError (request-invalid)", () => {
  const pkcAccessor = new InMemoryPkcAccessor();
  const coverageGate = new CoverageGate(pkcAccessor);
  assert.throws(
    () => new TestingOrchestrator({ coverageGate, gateG7Checker: new GateG7Checker() } as any),
    (err: unknown) => {
      assert.ok(err instanceof TestingOrchestratorError);
      assert.equal((err as TestingOrchestratorError).kind, "request-invalid", "kind 应为 request-invalid");
      assert.ok((err as TestingOrchestratorError).message.includes("gateG6Checker"), "错误消息应含 gateG6Checker");
      return true;
    }
  );
});

test("T2c: gateG7Checker 缺失 → 抛 TestingOrchestratorError (request-invalid)", () => {
  const pkcAccessor = new InMemoryPkcAccessor();
  const coverageGate = new CoverageGate(pkcAccessor);
  assert.throws(
    () => new TestingOrchestrator({ coverageGate, gateG6Checker: new GateG6Checker() } as any),
    (err: unknown) => {
      assert.ok(err instanceof TestingOrchestratorError);
      assert.equal((err as TestingOrchestratorError).kind, "request-invalid", "kind 应为 request-invalid");
      assert.ok((err as TestingOrchestratorError).message.includes("gateG7Checker"), "错误消息应含 gateG7Checker");
      return true;
    }
  );
});

// ============================================================================
// T3. run() 请求校验失败路径
// ============================================================================

test("T3a: projectRoot 空 → 抛 TestingOrchestratorError (request-invalid)", async () => {
  const pkcAccessor = new InMemoryPkcAccessor();
  const coverageGate = new CoverageGate(pkcAccessor);
  const orchestrator = new TestingOrchestrator({
    coverageGate,
    gateG6Checker: new GateG6Checker(),
    gateG7Checker: new GateG7Checker(),
  });
  const request = createTestingLoopRequest({ projectRoot: "" });

  await assert.rejects(
    () => orchestrator.run(request),
    (err: unknown) => {
      assert.ok(err instanceof TestingOrchestratorError);
      assert.equal((err as TestingOrchestratorError).kind, "request-invalid");
      assert.ok((err as TestingOrchestratorError).message.includes("projectRoot"));
      return true;
    }
  );
});

test("T3b: specContent 空 → 抛 TestingOrchestratorError (request-invalid)", async () => {
  const pkcAccessor = new InMemoryPkcAccessor();
  const coverageGate = new CoverageGate(pkcAccessor);
  const orchestrator = new TestingOrchestrator({
    coverageGate,
    gateG6Checker: new GateG6Checker(),
    gateG7Checker: new GateG7Checker(),
  });
  const request = createTestingLoopRequest({ specContent: "" });

  await assert.rejects(
    () => orchestrator.run(request),
    (err: unknown) => {
      assert.ok(err instanceof TestingOrchestratorError);
      assert.equal((err as TestingOrchestratorError).kind, "request-invalid");
      assert.ok((err as TestingOrchestratorError).message.includes("specContent"));
      return true;
    }
  );
});

test("T3c: planContent 空 → 抛 TestingOrchestratorError (request-invalid)", async () => {
  const pkcAccessor = new InMemoryPkcAccessor();
  const coverageGate = new CoverageGate(pkcAccessor);
  const orchestrator = new TestingOrchestrator({
    coverageGate,
    gateG6Checker: new GateG6Checker(),
    gateG7Checker: new GateG7Checker(),
  });
  const request = createTestingLoopRequest({ planContent: "" });

  await assert.rejects(
    () => orchestrator.run(request),
    (err: unknown) => {
      assert.ok(err instanceof TestingOrchestratorError);
      assert.equal((err as TestingOrchestratorError).kind, "request-invalid");
      assert.ok((err as TestingOrchestratorError).message.includes("planContent"));
      return true;
    }
  );
});

test("T3d: tasksContent 空 → 抛 TestingOrchestratorError (request-invalid)", async () => {
  const pkcAccessor = new InMemoryPkcAccessor();
  const coverageGate = new CoverageGate(pkcAccessor);
  const orchestrator = new TestingOrchestrator({
    coverageGate,
    gateG6Checker: new GateG6Checker(),
    gateG7Checker: new GateG7Checker(),
  });
  const request = createTestingLoopRequest({ tasksContent: "" });

  await assert.rejects(
    () => orchestrator.run(request),
    (err: unknown) => {
      assert.ok(err instanceof TestingOrchestratorError);
      assert.equal((err as TestingOrchestratorError).kind, "request-invalid");
      assert.ok((err as TestingOrchestratorError).message.includes("tasksContent"));
      return true;
    }
  );
});

test("T3f: taskDag 非对象（缺 nodes 数组） → 抛 TestingOrchestratorError (request-invalid)", async () => {
  const pkcAccessor = new InMemoryPkcAccessor();
  const coverageGate = new CoverageGate(pkcAccessor);
  const orchestrator = new TestingOrchestrator({
    coverageGate,
    gateG6Checker: new GateG6Checker(),
    gateG7Checker: new GateG7Checker(),
  });
  // 构造非法 taskDag（缺 nodes 数组）

  const request = createTestingLoopRequest({ taskDag: { topologicalOrder: [] } as any });

  await assert.rejects(
    () => orchestrator.run(request),
    (err: unknown) => {
      assert.ok(err instanceof TestingOrchestratorError);
      assert.equal((err as TestingOrchestratorError).kind, "request-invalid");
      assert.ok((err as TestingOrchestratorError).message.includes("taskDag"));
      return true;
    }
  );
});

test("T3g: acceptanceCriteria 非数组 → 抛 TestingOrchestratorError (request-invalid)", async () => {
  const pkcAccessor = new InMemoryPkcAccessor();
  const coverageGate = new CoverageGate(pkcAccessor);
  const orchestrator = new TestingOrchestrator({
    coverageGate,
    gateG6Checker: new GateG6Checker(),
    gateG7Checker: new GateG7Checker(),
  });

  const request = createTestingLoopRequest({ acceptanceCriteria: "invalid" as any });

  await assert.rejects(
    () => orchestrator.run(request),
    (err: unknown) => {
      assert.ok(err instanceof TestingOrchestratorError);
      assert.equal((err as TestingOrchestratorError).kind, "request-invalid");
      assert.ok((err as TestingOrchestratorError).message.includes("acceptanceCriteria"));
      return true;
    }
  );
});

test("T3h: llmClient 缺失 createMessage → 抛 TestingOrchestratorError (request-invalid)", async () => {
  const pkcAccessor = new InMemoryPkcAccessor();
  const coverageGate = new CoverageGate(pkcAccessor);
  const orchestrator = new TestingOrchestrator({
    coverageGate,
    gateG6Checker: new GateG6Checker(),
    gateG7Checker: new GateG7Checker(),
  });
  // 构造非法 llmClient（缺 createMessage 方法）

  const request = createTestingLoopRequest({ llmClient: {} as any });

  await assert.rejects(
    () => orchestrator.run(request),
    (err: unknown) => {
      assert.ok(err instanceof TestingOrchestratorError);
      assert.equal((err as TestingOrchestratorError).kind, "request-invalid");
      assert.ok((err as TestingOrchestratorError).message.includes("llmClient"));
      return true;
    }
  );
});

test("T3i: pkcAccessor 缺失 queryBusinessFlows → 抛 TestingOrchestratorError (request-invalid)", async () => {
  const pkcAccessor = new InMemoryPkcAccessor();
  const coverageGate = new CoverageGate(pkcAccessor);
  const orchestrator = new TestingOrchestrator({
    coverageGate,
    gateG6Checker: new GateG6Checker(),
    gateG7Checker: new GateG7Checker(),
  });
  // 构造非法 pkcAccessor（缺 queryBusinessFlows 方法）

  const request = createTestingLoopRequest({ pkcAccessor: {} as any });

  await assert.rejects(
    () => orchestrator.run(request),
    (err: unknown) => {
      assert.ok(err instanceof TestingOrchestratorError);
      assert.equal((err as TestingOrchestratorError).kind, "request-invalid");
      assert.ok((err as TestingOrchestratorError).message.includes("pkcAccessor"));
      return true;
    }
  );
});

test("T3j: loopGuard 缺失 check → 抛 TestingOrchestratorError (request-invalid)", async () => {
  const pkcAccessor = new InMemoryPkcAccessor();
  const coverageGate = new CoverageGate(pkcAccessor);
  const orchestrator = new TestingOrchestrator({
    coverageGate,
    gateG6Checker: new GateG6Checker(),
    gateG7Checker: new GateG7Checker(),
  });
  // 构造非法 loopGuard（缺 check 方法）

  const request = createTestingLoopRequest({ loopGuard: {} as any });

  await assert.rejects(
    () => orchestrator.run(request),
    (err: unknown) => {
      assert.ok(err instanceof TestingOrchestratorError);
      assert.equal((err as TestingOrchestratorError).kind, "request-invalid");
      assert.ok((err as TestingOrchestratorError).message.includes("loopGuard"));
      return true;
    }
  );
});

test("T3k: maxIterations < 1 → 抛 TestingOrchestratorError (request-invalid)", async () => {
  const pkcAccessor = new InMemoryPkcAccessor();
  const coverageGate = new CoverageGate(pkcAccessor);
  const orchestrator = new TestingOrchestrator({
    coverageGate,
    gateG6Checker: new GateG6Checker(),
    gateG7Checker: new GateG7Checker(),
  });
  const request = createTestingLoopRequest({ maxIterations: 0 });

  await assert.rejects(
    () => orchestrator.run(request),
    (err: unknown) => {
      assert.ok(err instanceof TestingOrchestratorError);
      assert.equal((err as TestingOrchestratorError).kind, "request-invalid");
      assert.ok((err as TestingOrchestratorError).message.includes("maxIterations"));
      return true;
    }
  );
});

test("T3l: maxIterations 超上限 → 抛 TestingOrchestratorError (request-invalid)", async () => {
  const pkcAccessor = new InMemoryPkcAccessor();
  const coverageGate = new CoverageGate(pkcAccessor);
  const orchestrator = new TestingOrchestrator({
    coverageGate,
    gateG6Checker: new GateG6Checker(),
    gateG7Checker: new GateG7Checker(),
  });
  // 超过 DEFAULT_MAX_TESTING_ITERATIONS * 10 = 50
  const request = createTestingLoopRequest({
    maxIterations: DEFAULT_MAX_TESTING_ITERATIONS * 10 + 1,
  });

  await assert.rejects(
    () => orchestrator.run(request),
    (err: unknown) => {
      assert.ok(err instanceof TestingOrchestratorError);
      assert.equal((err as TestingOrchestratorError).kind, "request-invalid");
      assert.ok((err as TestingOrchestratorError).message.includes("maxIterations"));
      return true;
    }
  );
});
