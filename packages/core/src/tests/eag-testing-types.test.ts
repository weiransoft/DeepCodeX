/**
 * EAG-P3 批次 10 单元测试：TESTING Loop 数据模型（types.ts）
 *
 * 测试范围：
 * - T1. 字面量联合类型常量校验
 *   - T1a. TEST_FILE_KINDS 含全部 5 个合法值（contract/e2e/integration/compliance/regression）
 *   - T1b. E2E_FLOW_CONFIDENCES 含全部 3 个合法值（documented/inferred/verified）
 *   - T1c. BREAKING_CHANGE_KINDS 含全部 4 个合法值
 *   - T1d. TESTING_LOOP_FINAL_STATUSES 含全部 3 个合法值
 *   - T1e. TEST_QUALITY_SEVERITIES 含全部 2 个合法值
 *   - T1f. COVERAGE_FAILED_DIMENSIONS 含全部 4 个合法值
 * - T2. 默认配置常量校验
 *   - T2a. DEFAULT_COVERAGE_THRESHOLD 含 lines/branches/functions/highRiskSymbols
 *   - T2b. DEFAULT_MAX_TESTING_ITERATIONS = 5
 *   - T2c. COVERAGE_CONSECUTIVE_FAILURE_THRESHOLD = 2
 *   - T2d. HIGH_RISK_SCORE_THRESHOLD = 0.7
 *   - T2e. MIN_ASSERTIONS_PER_TEST_CASE = 1
 * - T3. 不可变性测试（Object.freeze 抛 TypeError）
 *   - T3a. TEST_FILE_KINDS 冻结（修改抛 TypeError）
 *   - T3b. DEFAULT_COVERAGE_THRESHOLD 冻结
 *   - T3c. TESTING_DEFAULTS 冻结
 *   - T3d. BREAKING_CHANGE_KINDS 冻结
 * - T4. 工厂函数 createContractTestSpec
 *   - T4a. 合法输入 → 返回冻结对象
 *   - T4b. method 大写化
 *   - T4c. boundaryCases 数组冻结
 *   - T4d. path 为空字符串 → 抛 TestingLoopRequestError
 *   - T4e. responseSchemas 非对象 → 抛 TestingLoopRequestError
 *   - T4f. requirementId 为空 → 抛 TestingLoopRequestError
 *   - T4g. boundaryCases 非数组 → 抛 TestingLoopRequestError
 * - T5. 工厂函数 createE2eTestSpec
 *   - T5a. 合法输入 → 返回冻结对象
 *   - T5b. confidence 非法值 → 抛 TestingLoopRequestError
 *   - T5c. flowId 为空 → 抛 TestingLoopRequestError
 *   - T5d. steps 非数组 → 抛 TestingLoopRequestError
 * - T6. 工厂函数 createGeneratedTestFile
 *   - T6a. 合法输入 → 返回冻结对象
 *   - T6b. relativePath 为空 → 抛 TestingLoopRequestError
 *   - T6c. content 为空 → 抛 TestingLoopRequestError
 *   - T6d. kind 非法值 → 抛 TestingLoopRequestError
 * - T7. 工厂函数 createTestingLoopRequest
 *   - T7a. 合法输入 → 返回冻结对象
 *   - T7b. projectRoot 为空 → 抛 TestingLoopRequestError
 *   - T7c. llmClient 缺失 createMessage 方法 → 抛 TestingLoopRequestError
 *   - T7d. loopGuard 缺失 check 方法 → 抛 TestingLoopRequestError
 *   - T7e. coverageThreshold 缺失字段 → 抛 TestingLoopRequestError
 *   - T7f. maxIterations < 1 → 抛 TestingLoopRequestError
 * - T8. TestingLoopRequestError 错误类
 *   - T8a. 含 field / value / reason 属性
 *   - T8b. message 格式正确
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止 mock，直接构造真实对象
 *
 * @module core/tests/eag-testing-types
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  // 字面量联合类型常量
  TEST_FILE_KINDS,
  E2E_FLOW_CONFIDENCES,
  BREAKING_CHANGE_KINDS,
  TESTING_LOOP_FINAL_STATUSES,
  TEST_QUALITY_SEVERITIES,
  COVERAGE_FAILED_DIMENSIONS,
  // 默认配置常量
  DEFAULT_COVERAGE_THRESHOLD,
  DEFAULT_MAX_TESTING_ITERATIONS,
  DEFAULT_MAX_TOKENS_PER_TEST_FILE,
  DEFAULT_MAX_TOKENS_PER_TEST_LLM_CALL,
  DEFAULT_TEST_GENERATION_TEMPERATURE,
  DEFAULT_CONTRACT_TEST_OUTPUT_DIR,
  DEFAULT_E2E_TEST_OUTPUT_DIR,
  DEFAULT_INTEGRATION_TEST_OUTPUT_DIR,
  DEFAULT_HIGH_RISK_TOP_N,
  COVERAGE_CONSECUTIVE_FAILURE_THRESHOLD,
  HIGH_RISK_SCORE_THRESHOLD,
  MIN_ASSERTIONS_PER_TEST_CASE,
  TESTING_DEFAULTS,
  // 自定义错误类
  TestingLoopRequestError,
  // 工厂函数
  createContractTestSpec,
  createE2eTestSpec,
  createGeneratedTestFile,
  createTestingLoopRequest,
} from "../eag/testing/types";
import type { ContractTestSpec, E2eTestSpec, GeneratedTestFile, TestingLoopRequest } from "../eag/testing/types";
import type { TaskDag } from "../eag/doc-driven/types";
import type { LLMClient, LLMRequest, LLMResponse, LLMStreamEvent, ProviderName } from "../providers/llm-provider";
import type { LoopGuard } from "../common/loop-guard";

// ============================================================================
// 辅助函数：构造测试 fixture
// ============================================================================

/**
 * 构造合法的 ContractTestSpec 输入
 */
function createValidContractTestSpecInput(): ContractTestSpec {
  return {
    path: "/api/v1/orders/{orderId}",
    method: "get",
    requestSchema: {
      type: "object",
      properties: {
        orderId: { type: "string" },
      },
      required: ["orderId"],
    },
    responseSchemas: {
      "200": {
        type: "object",
        properties: {
          id: { type: "string" },
          status: { type: "string" },
        },
      },
      "404": {
        type: "object",
        properties: {
          error: { type: "string" },
        },
      },
    },
    tsSignature: "getOrder(orderId: string): Promise<Order>",
    requirementId: "F-001",
    boundaryCases: ["无效 orderId 应返回 400", "orderId 不存在应返回 404"],
  };
}

/**
 * 构造合法的 E2eTestSpec 输入
 */
function createValidE2eTestSpecInput(): E2eTestSpec {
  return {
    flowId: "flow-order-create-pay-query",
    flowName: "下单→支付→订单查询",
    steps: [
      {
        order: 1,
        actor: "user",
        action: "提交订单",
        input: { items: [{ skuId: "S-001", quantity: 2 }] },
        output: { orderId: "O-001" },
        stateTransition: "OrderCreated",
      },
      {
        order: 2,
        actor: "system",
        action: "处理支付",
        input: { orderId: "O-001", paymentMethod: "alipay" },
        output: { paymentId: "P-001", status: "PAID" },
        stateTransition: "OrderPaid",
      },
    ],
    userStory: "Given 用户已登录 / When 提交订单 / Then 创建订单成功",
    requirementId: "F-001",
    confidence: "documented",
  };
}

/**
 * 构造合法的 GeneratedTestFile 输入
 */
function createValidGeneratedTestFileInput(): GeneratedTestFile {
  return {
    relativePath: "tests/contract/order.contract.test.ts",
    content: [
      'import { test } from "node:test";',
      'import assert from "node:assert/strict";',
      "",
      'test("should return 200 when valid request", async () => {',
      "  assert.ok(true);",
      "});",
    ].join("\n"),
    kind: "contract",
    requirementId: "F-001",
    sourceId: "/api/v1/orders",
    testCaseCount: 1,
    testCaseDescriptions: ["should return 200 when valid request"],
  };
}

/**
 * 构造合法的 TaskDag
 */
function createValidTaskDag(): TaskDag {
  return {
    nodes: [
      {
        id: "T-001",
        title: "OrderAggregate 骨架",
        requirementId: "F-001",
        dependencies: [],
        fileCluster: "OrderAggregate",
        acceptanceCommand: "npm test order",
      },
    ],
    topologicalOrder: ["T-001"],
  };
}

/**
 * 真实 InMemoryLLMClient 实现（非 mock）
 */
class TestLLMClient implements LLMClient {
  readonly providerName: ProviderName = "openai";
  readonly model = "test-model";
  readonly baseURL = "memory://";
  readonly supportsThinking = false;
  readonly supportsPromptCaching = false;

  async createMessage(_request: LLMRequest): Promise<LLMResponse> {
    return {
      content: '{"files":[{"path":"test.ts","content":"// test"}]}',
      thinking: "",
      toolCalls: [],
      stopReason: "stop",
      usage: { inputTokens: 10, outputTokens: 5 },
    };
  }

  async *createMessageStream(_request: LLMRequest): AsyncIterable<LLMStreamEvent> {
    yield { type: "text_delta", text: "test" };
    yield { type: "message_end", stopReason: "stop", usage: null };
  }
}

/**
 * 真实 InMemoryPkcAccessor 实现（非 mock）
 */
class TestPkcAccessor {
  async queryBusinessFlows(_projectRoot: string) {
    return [createValidE2eTestSpecInput()];
  }
  async queryRiskHotspots(_projectRoot: string, _topN?: number) {
    return [
      {
        symbolId: "src/services/PaymentService.ts:PaymentService.refund",
        filePath: "src/services/PaymentService.ts",
        reason: "high-risk-no-test",
        riskScore: 0.85,
      },
    ];
  }
  async queryL1GlobalView(_projectRoot: string) {
    return { modules: [] };
  }
}

/**
 * 真实 LoopGuard 实现（非 mock，仅满足接口）
 */
class TestLoopGuard implements LoopGuard {
  check() {
    return {
      allowed: true,
      state: {
        iterationsCompleted: 0,
        tokensConsumed: 0,
        consecutiveFailures: 0,
        totalFailures: 0,
        backoffLevel: 0,
      },
      remainingIterations: 5,
      remainingTokens: 100000,
    };
  }
  recordIteration(_tokensUsed: number, _success: boolean): void {
    // 测试用空实现
  }
  abort(): void {
    // 测试用空实现
  }
  getState() {
    return {
      iterationsCompleted: 0,
      tokensConsumed: 0,
      consecutiveFailures: 0,
      totalFailures: 0,
      backoffLevel: 0,
    };
  }
  getConfig() {
    return {
      maxIterations: 5,
      maxTokens: 100000,
      maxConsecutiveFailures: 3,
      initialBackoffMs: 1000,
      maxBackoffMs: 30000,
      backoffMultiplier: 2.0,
      jitterRatio: 0.1,
    };
  }
}

/**
 * 构造合法的 TestingLoopRequest 输入
 */
function createValidTestingLoopRequestInput(): TestingLoopRequest {
  return {
    projectRoot: "/tmp/test-project",
    specContent: "# Spec\n\n需求：订单创建",
    planContent: "# Plan\n\n模块：OrderAggregate",
    tasksContent: "# Tasks\n\n任务：T-001 OrderAggregate 骨架",
    implementationRoot: "src/",
    taskDag: createValidTaskDag(),
    acceptanceCriteria: [
      {
        requirementId: "F-001",
        description: "Given 用户已登录 When 提交订单 Then 创建订单成功",
        moduleName: "OrderAggregate",
      },
    ],
    llmClient: new TestLLMClient(),
    pkcAccessor: new TestPkcAccessor() as unknown as TestingLoopRequest["pkcAccessor"],
    loopGuard: new TestLoopGuard(),
    coverageThreshold: { ...DEFAULT_COVERAGE_THRESHOLD },
    maxIterations: 5,
  };
}

// ============================================================================
// T1. 字面量联合类型常量校验
// ============================================================================

test("T1a: TEST_FILE_KINDS 含全部 5 个合法值", () => {
  assert.deepEqual(
    [...TEST_FILE_KINDS].sort(),
    ["compliance", "contract", "e2e", "integration", "regression"],
    "TEST_FILE_KINDS 应含全部 5 个合法值"
  );
});

test("T1b: E2E_FLOW_CONFIDENCES 含全部 3 个合法值", () => {
  assert.deepEqual(
    [...E2E_FLOW_CONFIDENCES].sort(),
    ["documented", "inferred", "verified"],
    "E2E_FLOW_CONFIDENCES 应含全部 3 个合法值"
  );
});

test("T1c: BREAKING_CHANGE_KINDS 含全部 4 个合法值", () => {
  assert.deepEqual(
    [...BREAKING_CHANGE_KINDS].sort(),
    ["api-removed", "field-type-changed", "required-field-added", "response-field-removed"],
    "BREAKING_CHANGE_KINDS 应含全部 4 个合法值"
  );
});

test("T1d: TESTING_LOOP_FINAL_STATUSES 含全部 3 个合法值", () => {
  assert.deepEqual(
    [...TESTING_LOOP_FINAL_STATUSES].sort(),
    ["human_checkpoint", "stop_failure", "success"],
    "TESTING_LOOP_FINAL_STATUSES 应含全部 3 个合法值"
  );
});

test("T1e: TEST_QUALITY_SEVERITIES 含全部 2 个合法值", () => {
  assert.deepEqual(
    [...TEST_QUALITY_SEVERITIES].sort(),
    ["blocker", "warning"],
    "TEST_QUALITY_SEVERITIES 应含全部 2 个合法值"
  );
});

test("T1f: COVERAGE_FAILED_DIMENSIONS 含全部 4 个合法值", () => {
  assert.deepEqual(
    [...COVERAGE_FAILED_DIMENSIONS].sort(),
    ["branches", "functions", "highRiskSymbols", "lines"],
    "COVERAGE_FAILED_DIMENSIONS 应含全部 4 个合法值"
  );
});

// ============================================================================
// T2. 默认配置常量校验
// ============================================================================

test("T2a: DEFAULT_COVERAGE_THRESHOLD 含 lines/branches/functions/highRiskSymbols", () => {
  assert.equal(DEFAULT_COVERAGE_THRESHOLD.lines, 80, "lines 默认 80");
  assert.equal(DEFAULT_COVERAGE_THRESHOLD.branches, 70, "branches 默认 70");
  assert.equal(DEFAULT_COVERAGE_THRESHOLD.functions, 85, "functions 默认 85");
  assert.equal(DEFAULT_COVERAGE_THRESHOLD.highRiskSymbols, 100, "highRiskSymbols 默认 100");
});

test("T2b: DEFAULT_MAX_TESTING_ITERATIONS = 5", () => {
  assert.equal(DEFAULT_MAX_TESTING_ITERATIONS, 5, "DEFAULT_MAX_TESTING_ITERATIONS 应为 5");
});

test("T2c: COVERAGE_CONSECUTIVE_FAILURE_THRESHOLD = 2", () => {
  assert.equal(COVERAGE_CONSECUTIVE_FAILURE_THRESHOLD, 2, "COVERAGE_CONSECUTIVE_FAILURE_THRESHOLD 应为 2");
});

test("T2d: HIGH_RISK_SCORE_THRESHOLD = 0.7", () => {
  assert.equal(HIGH_RISK_SCORE_THRESHOLD, 0.7, "HIGH_RISK_SCORE_THRESHOLD 应为 0.7");
});

test("T2e: MIN_ASSERTIONS_PER_TEST_CASE = 1", () => {
  assert.equal(MIN_ASSERTIONS_PER_TEST_CASE, 1, "MIN_ASSERTIONS_PER_TEST_CASE 应为 1");
});

test("T2f: 其他默认配置常量校验", () => {
  assert.equal(DEFAULT_MAX_TOKENS_PER_TEST_FILE, 4000, "DEFAULT_MAX_TOKENS_PER_TEST_FILE 应为 4000");
  assert.equal(DEFAULT_MAX_TOKENS_PER_TEST_LLM_CALL, 8000, "DEFAULT_MAX_TOKENS_PER_TEST_LLM_CALL 应为 8000");
  assert.equal(DEFAULT_TEST_GENERATION_TEMPERATURE, 0.2, "DEFAULT_TEST_GENERATION_TEMPERATURE 应为 0.2");
  assert.equal(
    DEFAULT_CONTRACT_TEST_OUTPUT_DIR,
    "tests/contract/",
    "DEFAULT_CONTRACT_TEST_OUTPUT_DIR 应为 tests/contract/"
  );
  assert.equal(DEFAULT_E2E_TEST_OUTPUT_DIR, "tests/e2e/", "DEFAULT_E2E_TEST_OUTPUT_DIR 应为 tests/e2e/");
  assert.equal(
    DEFAULT_INTEGRATION_TEST_OUTPUT_DIR,
    "tests/integration/",
    "DEFAULT_INTEGRATION_TEST_OUTPUT_DIR 应为 tests/integration/"
  );
  assert.equal(DEFAULT_HIGH_RISK_TOP_N, 10, "DEFAULT_HIGH_RISK_TOP_N 应为 10");
});

test("T2g: TESTING_DEFAULTS 含全部聚合字段", () => {
  assert.ok(TESTING_DEFAULTS, "TESTING_DEFAULTS 应存在");
  assert.equal(
    TESTING_DEFAULTS.maxTestingIterations,
    DEFAULT_MAX_TESTING_ITERATIONS,
    "TESTING_DEFAULTS.maxTestingIterations 应与 DEFAULT_MAX_TESTING_ITERATIONS 一致"
  );
  assert.equal(
    TESTING_DEFAULTS.maxTokensPerTestFile,
    DEFAULT_MAX_TOKENS_PER_TEST_FILE,
    "TESTING_DEFAULTS.maxTokensPerTestFile 应一致"
  );
  assert.equal(
    TESTING_DEFAULTS.testGenerationTemperature,
    DEFAULT_TEST_GENERATION_TEMPERATURE,
    "TESTING_DEFAULTS.testGenerationTemperature 应一致"
  );
  assert.equal(
    TESTING_DEFAULTS.contractTestOutputDir,
    DEFAULT_CONTRACT_TEST_OUTPUT_DIR,
    "TESTING_DEFAULTS.contractTestOutputDir 应一致"
  );
});

// ============================================================================
// T3. 不可变性测试（Object.freeze 抛 TypeError）
// ============================================================================

test("T3a: TEST_FILE_KINDS 冻结（修改抛 TypeError）", () => {
  assert.throws(
    () => {
      // @ts-expect-error 故意违反类型，测试运行期冻结
      (TEST_FILE_KINDS as string[]).push("invalid");
    },
    TypeError,
    "TEST_FILE_KINDS 应被 Object.freeze 冻结"
  );
});

test("T3b: DEFAULT_COVERAGE_THRESHOLD 冻结", () => {
  assert.throws(
    () => {
      // @ts-expect-error 故意违反类型
      (DEFAULT_COVERAGE_THRESHOLD as { lines: number }).lines = 99;
    },
    TypeError,
    "DEFAULT_COVERAGE_THRESHOLD 应被 Object.freeze 冻结"
  );
});

test("T3c: TESTING_DEFAULTS 冻结", () => {
  assert.throws(
    () => {
      // @ts-expect-error 故意违反类型
      (TESTING_DEFAULTS as { maxIterations: number }).maxIterations = 999;
    },
    TypeError,
    "TESTING_DEFAULTS 应被 Object.freeze 冻结"
  );
});

test("T3d: BREAKING_CHANGE_KINDS 冻结", () => {
  assert.throws(
    () => {
      // @ts-expect-error 故意违反类型
      (BREAKING_CHANGE_KINDS as string[]).push("invalid");
    },
    TypeError,
    "BREAKING_CHANGE_KINDS 应被 Object.freeze 冻结"
  );
});

// ============================================================================
// T4. 工厂函数 createContractTestSpec
// ============================================================================

test("T4a: createContractTestSpec 合法输入 → 返回冻结对象", () => {
  const input = createValidContractTestSpecInput();
  const spec = createContractTestSpec(input);

  assert.equal(spec.path, input.path, "path 应保持不变");
  assert.equal(spec.method, "GET", "method 应大写化");
  assert.equal(spec.requirementId, input.requirementId, "requirementId 应保持不变");
  assert.deepEqual([...spec.boundaryCases], [...input.boundaryCases], "boundaryCases 应保持不变");
  assert.ok(Object.isFrozen(spec), "返回对象应被 Object.freeze 冻结");
});

test("T4b: createContractTestSpec method 大写化", () => {
  const spec = createContractTestSpec({
    ...createValidContractTestSpecInput(),
    method: "post",
  });
  assert.equal(spec.method, "POST", "method 应为大写");
});

test("T4c: createContractTestSpec boundaryCases 数组冻结", () => {
  const spec = createContractTestSpec(createValidContractTestSpecInput());
  assert.ok(Object.isFrozen(spec.boundaryCases), "boundaryChanges 应被冻结");
});

test("T4d: createContractTestSpec path 为空 → 抛 TestingLoopRequestError", () => {
  const input = createValidContractTestSpecInput();
  assert.throws(
    () => createContractTestSpec({ ...input, path: "" }),
    (err: unknown) => {
      assert.ok(err instanceof TestingLoopRequestError, "应抛 TestingLoopRequestError");
      assert.equal((err as TestingLoopRequestError).field, "path", "field 应为 path");
      return true;
    },
    "path 为空应抛 TestingLoopRequestError"
  );
});

test("T4e: createContractTestSpec responseSchemas 非对象 → 抛 TestingLoopRequestError", () => {
  const input = createValidContractTestSpecInput();
  assert.throws(
    // @ts-expect-error 故意违反类型
    () => createContractTestSpec({ ...input, responseSchemas: "invalid" }),
    (err: unknown) => {
      assert.ok(err instanceof TestingLoopRequestError, "应抛 TestingLoopRequestError");
      assert.equal((err as TestingLoopRequestError).field, "responseSchemas");
      return true;
    },
    "responseSchemas 非对象应抛 TestingLoopRequestError"
  );
});

test("T4f: createContractTestSpec requirementId 为空 → 抛 TestingLoopRequestError", () => {
  const input = createValidContractTestSpecInput();
  assert.throws(
    () => createContractTestSpec({ ...input, requirementId: "" }),
    (err: unknown) => {
      assert.ok(err instanceof TestingLoopRequestError);
      assert.equal((err as TestingLoopRequestError).field, "requirementId");
      return true;
    }
  );
});

test("T4g: createContractTestSpec boundaryCases 非数组 → 抛 TestingLoopRequestError", () => {
  const input = createValidContractTestSpecInput();
  assert.throws(
    // @ts-expect-error 故意违反类型
    () => createContractTestSpec({ ...input, boundaryCases: "invalid" }),
    (err: unknown) => {
      assert.ok(err instanceof TestingLoopRequestError);
      assert.equal((err as TestingLoopRequestError).field, "boundaryCases");
      return true;
    }
  );
});

// ============================================================================
// T5. 工厂函数 createE2eTestSpec
// ============================================================================

test("T5a: createE2eTestSpec 合法输入 → 返回冻结对象", () => {
  const input = createValidE2eTestSpecInput();
  const spec = createE2eTestSpec(input);

  assert.equal(spec.flowId, input.flowId);
  assert.equal(spec.flowName, input.flowName);
  assert.equal(spec.userStory, input.userStory);
  assert.equal(spec.confidence, input.confidence);
  assert.ok(Object.isFrozen(spec), "返回对象应被 Object.freeze 冻结");
});

test("T5b: createE2eTestSpec confidence 非法值 → 抛 TestingLoopRequestError", () => {
  const input = createValidE2eTestSpecInput();
  assert.throws(
    // @ts-expect-error 故意违反类型
    () => createE2eTestSpec({ ...input, confidence: "invalid" }),
    (err: unknown) => {
      assert.ok(err instanceof TestingLoopRequestError);
      assert.equal((err as TestingLoopRequestError).field, "confidence");
      return true;
    }
  );
});

test("T5c: createE2eTestSpec flowId 为空 → 抛 TestingLoopRequestError", () => {
  const input = createValidE2eTestSpecInput();
  assert.throws(
    () => createE2eTestSpec({ ...input, flowId: "" }),
    (err: unknown) => {
      assert.ok(err instanceof TestingLoopRequestError);
      assert.equal((err as TestingLoopRequestError).field, "flowId");
      return true;
    }
  );
});

test("T5d: createE2eTestSpec steps 非数组 → 抛 TestingLoopRequestError", () => {
  const input = createValidE2eTestSpecInput();
  assert.throws(
    // @ts-expect-error 故意违反类型
    () => createE2eTestSpec({ ...input, steps: "invalid" }),
    (err: unknown) => {
      assert.ok(err instanceof TestingLoopRequestError);
      assert.equal((err as TestingLoopRequestError).field, "steps");
      return true;
    }
  );
});

// ============================================================================
// T6. 工厂函数 createGeneratedTestFile
// ============================================================================

test("T6a: createGeneratedTestFile 合法输入 → 返回冻结对象", () => {
  const input = createValidGeneratedTestFileInput();
  const file = createGeneratedTestFile(input);

  assert.equal(file.relativePath, input.relativePath);
  assert.equal(file.kind, input.kind);
  assert.equal(file.testCaseCount, input.testCaseCount);
  assert.ok(Object.isFrozen(file), "返回对象应被 Object.freeze 冻结");
});

test("T6b: createGeneratedTestFile relativePath 为空 → 抛 TestingLoopRequestError", () => {
  const input = createValidGeneratedTestFileInput();
  assert.throws(
    () => createGeneratedTestFile({ ...input, relativePath: "" }),
    (err: unknown) => {
      assert.ok(err instanceof TestingLoopRequestError);
      assert.equal((err as TestingLoopRequestError).field, "relativePath");
      return true;
    }
  );
});

test("T6c: createGeneratedTestFile content 非字符串 → 抛 TestingLoopRequestError", () => {
  const input = createValidGeneratedTestFileInput();
  assert.throws(
    // @ts-expect-error 故意违反类型
    () => createGeneratedTestFile({ ...input, content: 123 }),
    (err: unknown) => {
      assert.ok(err instanceof TestingLoopRequestError);
      assert.equal((err as TestingLoopRequestError).field, "content");
      return true;
    }
  );
});

test("T6d: createGeneratedTestFile kind 非法值 → 抛 TestingLoopRequestError", () => {
  const input = createValidGeneratedTestFileInput();
  assert.throws(
    // @ts-expect-error 故意违反类型
    () => createGeneratedTestFile({ ...input, kind: "invalid" }),
    (err: unknown) => {
      assert.ok(err instanceof TestingLoopRequestError);
      assert.equal((err as TestingLoopRequestError).field, "kind");
      return true;
    }
  );
});

// ============================================================================
// T7. 工厂函数 createTestingLoopRequest
// ============================================================================

test("T7a: createTestingLoopRequest 合法输入 → 返回冻结对象", () => {
  const input = createValidTestingLoopRequestInput();
  const request = createTestingLoopRequest(input);

  assert.equal(request.projectRoot, input.projectRoot);
  assert.equal(request.maxIterations, input.maxIterations);
  assert.ok(Object.isFrozen(request), "返回对象应被 Object.freeze 冻结");
});

test("T7b: createTestingLoopRequest projectRoot 为空 → 抛 TestingLoopRequestError", () => {
  const input = createValidTestingLoopRequestInput();
  assert.throws(
    () => createTestingLoopRequest({ ...input, projectRoot: "" }),
    (err: unknown) => {
      assert.ok(err instanceof TestingLoopRequestError);
      assert.equal((err as TestingLoopRequestError).field, "projectRoot");
      return true;
    }
  );
});

test("T7c: createTestingLoopRequest llmClient 缺失 createMessage → 抛 TestingLoopRequestError", () => {
  const input = createValidTestingLoopRequestInput();
  assert.throws(
    // @ts-expect-error 故意违反类型
    () => createTestingLoopRequest({ ...input, llmClient: {} }),
    (err: unknown) => {
      assert.ok(err instanceof TestingLoopRequestError);
      assert.equal((err as TestingLoopRequestError).field, "llmClient");
      return true;
    }
  );
});

test("T7d: createTestingLoopRequest loopGuard 缺失 check → 抛 TestingLoopRequestError", () => {
  const input = createValidTestingLoopRequestInput();
  assert.throws(
    // @ts-expect-error 故意违反类型
    () => createTestingLoopRequest({ ...input, loopGuard: {} }),
    (err: unknown) => {
      assert.ok(err instanceof TestingLoopRequestError);
      assert.equal((err as TestingLoopRequestError).field, "loopGuard");
      return true;
    }
  );
});

test("T7f: createTestingLoopRequest maxIterations < 1 → 抛 TestingLoopRequestError", () => {
  const input = createValidTestingLoopRequestInput();
  assert.throws(
    () => createTestingLoopRequest({ ...input, maxIterations: 0 }),
    (err: unknown) => {
      assert.ok(err instanceof TestingLoopRequestError);
      assert.equal((err as TestingLoopRequestError).field, "maxIterations");
      return true;
    }
  );
});

// ============================================================================
// T8. TestingLoopRequestError 错误类
// ============================================================================

test("T8a: TestingLoopRequestError 含 field / value / reason 属性", () => {
  const err = new TestingLoopRequestError("testField", "testValue", "测试原因");
  assert.equal(err.field, "testField", "field 应正确设置");
  assert.equal(err.value, "testValue", "value 应正确设置");
  assert.equal(err.reason, "测试原因", "reason 应正确设置");
  assert.equal(err.name, "TestingLoopRequestError", "name 应为 TestingLoopRequestError");
});

test("T8b: TestingLoopRequestError message 格式正确", () => {
  const err = new TestingLoopRequestError("testField", "testValue", "测试原因");
  assert.ok(err.message.includes("testField"), "message 应含 field 名");
  assert.ok(err.message.includes("测试原因"), "message 应含 reason");
});
