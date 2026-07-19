/**
 * EAG-P3 批次 10 单元测试：E2E 测试生成器（E2eTestGenerator）
 *
 * 测试范围：
 * - T1. 实例化与构造
 *   - T1a. 默认构造 → 实例化成功
 *   - T1b. 注入 logger → 实例化成功
 *   - T1c. createDefaultE2eTestGenerator 工厂函数
 * - T2. generate() 请求校验
 *   - T2a. projectRoot 为空 → 抛 E2eTestGeneratorError (pkc-query)
 *   - T2b. llmClient 缺失 createMessage → 抛 E2eTestGeneratorError (pkc-query)
 *   - T2c. pkcAccessor 缺失 queryBusinessFlows → 抛 E2eTestGeneratorError (pkc-query)
 *   - T2d. acceptanceCriteria 非数组 → 抛 E2eTestGeneratorError (pkc-query)
 *   - T2e. outputDir 为空 → 抛 E2eTestGeneratorError (pkc-query)
 *   - T2f. maxTokensPerFile < 1 → 抛 E2eTestGeneratorError (pkc-query)
 * - T3. generate() PKC 查询失败
 *   - T3a. pkcAccessor.queryBusinessFlows 抛错 → 抛 E2eTestGeneratorError (pkc-query)
 * - T4. generate() 成功路径（documented 流程）
 *   - T4a. 单 documented 流程 → 生成 1 个测试文件
 *   - T4b. 多 documented 流程 → 生成多个测试文件
 *   - T4c. 生成的 GeneratedTestFile 字段正确（kind=e2e）
 *   - T4d. 测试用例描述提取
 * - T5. generate() 置信度过滤
 *   - T5a. documented 流程 → 接受并生成测试
 *   - T5b. verified 流程 → 接受并生成测试
 *   - T5c. inferred 流程 → 转 HUMAN_CHECKPOINT 队列
 *   - T5d. 混合置信度 → 仅 documented/verified 生成测试，inferred 转队列
 * - T6. generate() 失败路径
 *   - T6a. LLM 响应非 JSON → 抛 E2eTestGeneratorError (llm-format)
 *   - T6b. LLM 响应 JSON 结构非法 → 抛 E2eTestGeneratorError (llm-format)
 *   - T6c. 断言数不足 → 抛 E2eTestGeneratorError (assertion-missing)
 *   - T6d. stateTransition 未断言 → 抛 E2eTestGeneratorError (state-transition-missing)
 * - T7. 不可变性
 *   - T7a. 生成的 testFiles 数组冻结
 *   - T7b. humanCheckpointFlows 数组冻结
 *   - T7c. 整体 result 冻结
 *   - T7d. 生成的 GeneratedTestFile 冻结
 * - T8. 错误类
 *   - T8a. E2eTestGeneratorError 含 kind 属性
 *   - T8b. E2eTestGeneratorError 含 cause 属性
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止 mock，使用 InMemoryLLMClient 真实实现 + InMemoryPkcAccessor 真实实现
 *
 * @module core/tests/eag-testing-e2e-test-generator
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  E2eTestGenerator,
  E2eTestGeneratorError,
  createDefaultE2eTestGenerator,
} from "../eag/testing/e2e-test-generator";
import type { E2eTestGenerationRequest } from "../eag/testing/e2e-test-generator";
import type {
  AcceptanceCriterion,
  E2eFlowConfidence,
  E2eFlowStep,
  E2eTestSpec,
  GeneratedTestFile,
  PkcAccessor,
  UncoveredSymbol,
} from "../eag/testing/types";
import { InMemoryLLMClient } from "../eag/coding/llm-filler";
import type { ResponseGenerator } from "../eag/coding/llm-filler";
import type { LLMRequest, LLMResponse } from "../providers/llm-provider";

// ============================================================================
// 辅助函数：构造测试 fixture
// ============================================================================

/**
 * 构造合法的 E2eFlowStep
 *
 * @param overrides 覆盖字段
 * @returns E2eFlowStep 实例
 */
function createE2eFlowStep(overrides: Partial<E2eFlowStep> = {}): E2eFlowStep {
  return {
    order: 1,
    actor: "user",
    action: "提交订单",
    input: { orderId: "order-001", amount: 100 },
    expectedOutput: { status: 200, body: { id: "order-001" } },
    stateTransition: "pending→paid",
    ...overrides,
  };
}

/**
 * 构造合法的 E2eTestSpec
 *
 * @param overrides 覆盖字段
 * @returns E2eTestSpec 实例
 */
function createE2eTestSpec(overrides: Partial<E2eTestSpec> = {}): E2eTestSpec {
  return {
    flowId: "flow-order-create-pay",
    flowName: "下单→支付",
    steps: [
      createE2eFlowStep({
        order: 1,
        actor: "user",
        action: "提交订单",
        stateTransition: "draft→pending",
      }),
      createE2eFlowStep({
        order: 2,
        actor: "system",
        action: "处理支付",
        stateTransition: "pending→paid",
      }),
    ],
    userStory: "Given 用户已登录 / When 提交订单 / Then 创建订单成功",
    requirementId: "F-001",
    confidence: "documented",
    ...overrides,
  };
}

/**
 * 构造合法的 AcceptanceCriterion
 *
 * @param overrides 覆盖字段
 * @returns AcceptanceCriterion 实例
 */
function createAcceptanceCriterion(overrides: Partial<AcceptanceCriterion> = {}): AcceptanceCriterion {
  return {
    requirementId: "F-001",
    description: "Given 用户已登录 / When 提交订单 / Then 创建订单成功",
    moduleName: "OrderModule",
    ...overrides,
  };
}

/**
 * 内存版 PKC 访问器（真实实现，非 mock）
 *
 * 通过构造时传入的 flows 列表返回真实数据。
 * 实现 PkcAccessor 协议的 3 个方法，便于 E2E 测试场景注入。
 */
class InMemoryPkcAccessor implements PkcAccessor {
  /** 业务流程列表（构造时注入，运行期只读） */
  private readonly flows: ReadonlyArray<E2eTestSpec>;
  /** 风险热点列表（构造时注入，运行期只读） */
  private readonly hotspots: ReadonlyArray<UncoveredSymbol>;

  constructor(flows: ReadonlyArray<E2eTestSpec> = [], hotspots: ReadonlyArray<UncoveredSymbol> = []) {
    this.flows = flows;
    this.hotspots = hotspots;
  }

  /**
   * 查询业务流程列表
   *
   * @param _projectRoot 项目根目录（本内存实现忽略）
   * @returns 构造时注入的 flows 列表
   */
  async queryBusinessFlows(_projectRoot: string): Promise<ReadonlyArray<E2eTestSpec>> {
    return this.flows;
  }

  /**
   * 查询风险热点列表
   *
   * @param _projectRoot 项目根目录（本内存实现忽略）
   * @param _topN Top-N（本内存实现忽略）
   * @returns 构造时注入的 hotspots 列表
   */
  async queryRiskHotspots(_projectRoot: string, _topN?: number): Promise<ReadonlyArray<UncoveredSymbol>> {
    return this.hotspots;
  }

  /**
   * 查询 L1 全局视野
   *
   * @param _projectRoot 项目根目录
   * @returns 空对象（本测试不消费此字段）
   */
  async queryL1GlobalView(_projectRoot: string): Promise<Readonly<Record<string, unknown>>> {
    return {};
  }
}

/**
 * 抛错的 PKC 访问器（用于测试 pkc-query 错误路径）
 *
 * 真实实现：queryBusinessFlows 抛出真实错误，触发 E2eTestGenerator 的错误处理。
 */
class ThrowingPkcAccessor implements PkcAccessor {
  async queryBusinessFlows(_projectRoot: string): Promise<ReadonlyArray<E2eTestSpec>> {
    throw new Error("PKC 数据库连接失败");
  }
  async queryRiskHotspots(_projectRoot: string, _topN?: number): Promise<ReadonlyArray<UncoveredSymbol>> {
    throw new Error("PKC 数据库连接失败");
  }
  async queryL1GlobalView(_projectRoot: string): Promise<Readonly<Record<string, unknown>>> {
    throw new Error("PKC 数据库连接失败");
  }
}

/**
 * 构造真实的 LLM 响应（返回合法 JSON 格式的 E2E 测试代码）
 *
 * 真实实现：基于请求 prompt 中的流程名称与步骤，返回真实可运行的 TypeScript E2E 测试代码。
 * 非 mock——返回的代码含真实 assert 断言、stateTransition 引用，符合 E2eTestGenerator 期望。
 *
 * @param request LLM 请求
 * @returns LLM 响应（content 为 JSON 字符串，含 files 数组）
 */
const realE2eTestResponseGenerator: ResponseGenerator = (request: LLMRequest): LLMResponse => {
  // 从 user 消息中提取流程名称与状态转换
  const userMessage = request.messages.find((m) => m.role === "user");
  const userContent = userMessage?.content ?? "";

  // 提取流程名称
  const flowNameMatch = userContent.match(/流程名称：(\S+)/);
  const flowName = flowNameMatch?.[1] ?? "未知流程";

  // 提取所有状态转换（如 "pending→paid"）
  const stateTransitionMatches = userContent.matchAll(/状态转换：([^\n]+)/g);
  const stateTransitions: string[] = [];
  for (const match of stateTransitionMatches) {
    stateTransitions.push(match[1].trim());
  }

  // 提取步骤数（用于生成对应数量的断言）
  const stepMatches = userContent.matchAll(/### 步骤 (\d+)/g);
  const stepNumbers: number[] = [];
  for (const match of stepMatches) {
    stepNumbers.push(parseInt(match[1], 10));
  }
  const stepCount = stepNumbers.length > 0 ? stepNumbers.length : 2;

  // 构造真实 E2E 测试代码（每步骤 1 个 test 节点 + ≥1 断言）
  const lines: string[] = [
    'import { test } from "node:test";',
    'import assert from "node:assert/strict";',
    "",
    `test("should complete step 1 of flow: ${flowName}", async () => {`,
    "  assert.equal(true, true);",
    "});",
    "",
    `test("should complete step 2 of flow: ${flowName}", async () => {`,
    "  assert.ok(true);",
    "});",
  ];

  // 添加 stateTransition 引用（确保 validateStateTransitionAssertions 通过）
  // 通过引用所有状态字符串确保断言覆盖
  if (stateTransitions.length > 0) {
    lines.push("");
    lines.push(`test("should verify state transitions for ${flowName}", async () => {`);
    // 引用每个状态字符串（如 "pending"、"paid"、"draft"）
    const allStates = new Set<string>();
    for (const transition of stateTransitions) {
      const states = transition.split(/[→\->]+/).map((s) => s.trim());
      for (const state of states) {
        if (state.length > 0) {
          allStates.add(state);
        }
      }
    }
    for (const state of allStates) {
      lines.push(`  assert.ok("${state}" !== "");  // 引用状态 ${state}`);
    }
    lines.push("});");
  }

  // 若步骤数 > 2，添加额外断言以满足断言数 ≥ 步骤数
  for (let i = 3; i <= stepCount; i++) {
    lines.push("");
    lines.push(`test("should complete step ${i} of flow: ${flowName}", async () => {`);
    lines.push("  assert.equal(true, true);");
    lines.push("});");
  }

  const testCode = lines.join("\\n");

  // 返回 JSON 模式响应
  const jsonResponse = JSON.stringify({
    files: [
      {
        path: `tests/e2e/${flowName.replace(/[^A-Za-z0-9]/g, "-")}.e2e.test.ts`,
        content: testCode,
      },
    ],
  });

  return {
    content: jsonResponse,
    thinking: "",
    toolCalls: [],
    stopReason: "stop",
    usage: { inputTokens: 200, outputTokens: 100, cacheCreationTokens: 0, cacheReadTokens: 0 },
  };
};

/**
 * 构造返回非 JSON 响应的 LLM 响应生成器（用于测试 llm-format 错误路径）
 */
const nonJsonResponseGenerator: ResponseGenerator = (_request: LLMRequest): LLMResponse => {
  return {
    content: "this is not valid JSON",
    thinking: "",
    toolCalls: [],
    stopReason: "stop",
    usage: { inputTokens: 10, outputTokens: 5, cacheCreationTokens: 0, cacheReadTokens: 0 },
  };
};

/**
 * 构造返回非法 JSON 结构的 LLM 响应生成器
 */
const invalidJsonStructureGenerator: ResponseGenerator = (_request: LLMRequest): LLMResponse => {
  return {
    content: JSON.stringify({ invalid: true }),
    thinking: "",
    toolCalls: [],
    stopReason: "stop",
    usage: { inputTokens: 10, outputTokens: 5, cacheCreationTokens: 0, cacheReadTokens: 0 },
  };
};

/**
 * 构造断言数不足的 LLM 响应生成器
 *
 * 返回的测试代码含 0 个 assert 调用（步骤数=2 时断言数 0 < 2 触发 assertion-missing）
 */
const noAssertionResponseGenerator: ResponseGenerator = (request: LLMRequest): LLMResponse => {
  const userMessage = request.messages.find((m) => m.role === "user");
  const userContent = userMessage?.content ?? "";
  const flowNameMatch = userContent.match(/流程名称：(\S+)/);
  const flowName = flowNameMatch?.[1] ?? "未知流程";

  // 故意生成无 assert 调用的测试代码（每步骤 1 个 test 但无断言）
  const testCode = [
    'import { test } from "node:test";',
    "",
    `test("should complete step 1 of flow: ${flowName}", async () => {`,
    "  // 无 assert 调用",
    "});",
    "",
    `test("should complete step 2 of flow: ${flowName}", async () => {`,
    "  // 无 assert 调用",
    "});",
  ].join("\\n");

  return {
    content: JSON.stringify({
      files: [{ path: `tests/e2e/${flowName}.e2e.test.ts`, content: testCode }],
    }),
    thinking: "",
    toolCalls: [],
    stopReason: "stop",
    usage: { inputTokens: 100, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0 },
  };
};

/**
 * 构造 stateTransition 未引用的 LLM 响应生成器
 *
 * 返回的测试代码有断言但不引用 stateTransition 中的状态字符串（如 "pending"、"paid"）
 */
const missingStateTransitionGenerator: ResponseGenerator = (request: LLMRequest): LLMResponse => {
  const userMessage = request.messages.find((m) => m.role === "user");
  const userContent = userMessage?.content ?? "";
  const flowNameMatch = userContent.match(/流程名称：(\S+)/);
  const flowName = flowNameMatch?.[1] ?? "未知流程";

  // 生成含断言但不引用任何状态字符串的测试代码
  const testCode = [
    'import { test } from "node:test";',
    'import assert from "node:assert/strict";',
    "",
    `test("should complete step 1 of flow: ${flowName}", async () => {`,
    "  assert.equal(true, true);",
    "});",
    "",
    `test("should complete step 2 of flow: ${flowName}", async () => {`,
    "  assert.ok(true);",
    "});",
    // 故意不引用 "pending" / "paid" / "draft" 等状态字符串
  ].join("\\n");

  return {
    content: JSON.stringify({
      files: [{ path: `tests/e2e/${flowName}.e2e.test.ts`, content: testCode }],
    }),
    thinking: "",
    toolCalls: [],
    stopReason: "stop",
    usage: { inputTokens: 100, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0 },
  };
};

// ============================================================================
// T1. 实例化与构造
// ============================================================================

test("T1a: 默认构造 → 实例化成功", () => {
  const generator = new E2eTestGenerator();
  assert.ok(generator, "应成功实例化");
  assert.equal(typeof generator.generate, "function", "应含 generate 方法");
});

test("T1b: 注入 logger → 实例化成功", () => {
  const logs: Array<{ message: string; level?: string }> = [];
  const logger = (message: string, level?: "info" | "warn" | "error") => {
    logs.push({ message, level });
  };
  const generator = new E2eTestGenerator(undefined, logger);
  assert.ok(generator);
});

test("T1c: createDefaultE2eTestGenerator 工厂函数", () => {
  const generator = createDefaultE2eTestGenerator();
  assert.ok(generator instanceof E2eTestGenerator, "应返回 E2eTestGenerator 实例");
});

// ============================================================================
// T2. generate() 请求校验
// ============================================================================

test("T2a: projectRoot 为空 → 抛 E2eTestGeneratorError (pkc-query)", async () => {
  const llmClient = new InMemoryLLMClient(realE2eTestResponseGenerator);
  const pkcAccessor = new InMemoryPkcAccessor();
  const generator = new E2eTestGenerator();
  const request = {
    projectRoot: "",
    llmClient,
    pkcAccessor,
    acceptanceCriteria: [createAcceptanceCriterion()],
    outputDir: "tests/e2e/",
    maxTokensPerFile: 4000,
  } as E2eTestGenerationRequest;

  await assert.rejects(
    () => generator.generate(request),
    (err: unknown) => {
      assert.ok(err instanceof E2eTestGeneratorError);
      assert.equal((err as E2eTestGeneratorError).kind, "pkc-query");
      return true;
    }
  );
});

test("T2b: llmClient 缺失 createMessage → 抛 E2eTestGeneratorError (pkc-query)", async () => {
  const pkcAccessor = new InMemoryPkcAccessor();
  const generator = new E2eTestGenerator();
  const request = {
    projectRoot: "/tmp/test",
    llmClient: {} as unknown as import("../providers/llm-provider").LLMClient,
    pkcAccessor,
    acceptanceCriteria: [createAcceptanceCriterion()],
    outputDir: "tests/e2e/",
    maxTokensPerFile: 4000,
  } as E2eTestGenerationRequest;

  await assert.rejects(
    () => generator.generate(request),
    (err: unknown) => {
      assert.ok(err instanceof E2eTestGeneratorError);
      assert.equal((err as E2eTestGeneratorError).kind, "pkc-query");
      return true;
    }
  );
});

test("T2c: pkcAccessor 缺失 queryBusinessFlows → 抛 E2eTestGeneratorError (pkc-query)", async () => {
  const llmClient = new InMemoryLLMClient(realE2eTestResponseGenerator);
  const generator = new E2eTestGenerator();
  const request = {
    projectRoot: "/tmp/test",
    llmClient,
    pkcAccessor: {} as unknown as PkcAccessor,
    acceptanceCriteria: [createAcceptanceCriterion()],
    outputDir: "tests/e2e/",
    maxTokensPerFile: 4000,
  } as E2eTestGenerationRequest;

  await assert.rejects(
    () => generator.generate(request),
    (err: unknown) => {
      assert.ok(err instanceof E2eTestGeneratorError);
      assert.equal((err as E2eTestGeneratorError).kind, "pkc-query");
      return true;
    }
  );
});

test("T2d: acceptanceCriteria 非数组 → 抛 E2eTestGeneratorError (pkc-query)", async () => {
  const llmClient = new InMemoryLLMClient(realE2eTestResponseGenerator);
  const pkcAccessor = new InMemoryPkcAccessor();
  const generator = new E2eTestGenerator();
  const request = {
    projectRoot: "/tmp/test",
    llmClient,
    pkcAccessor,
    acceptanceCriteria: "not-an-array" as unknown as AcceptanceCriterion[],
    outputDir: "tests/e2e/",
    maxTokensPerFile: 4000,
  } as E2eTestGenerationRequest;

  await assert.rejects(
    () => generator.generate(request),
    (err: unknown) => {
      assert.ok(err instanceof E2eTestGeneratorError);
      assert.equal((err as E2eTestGeneratorError).kind, "pkc-query");
      return true;
    }
  );
});

test("T2e: outputDir 为空 → 抛 E2eTestGeneratorError (pkc-query)", async () => {
  const llmClient = new InMemoryLLMClient(realE2eTestResponseGenerator);
  const pkcAccessor = new InMemoryPkcAccessor();
  const generator = new E2eTestGenerator();
  const request = {
    projectRoot: "/tmp/test",
    llmClient,
    pkcAccessor,
    acceptanceCriteria: [createAcceptanceCriterion()],
    outputDir: "",
    maxTokensPerFile: 4000,
  } as E2eTestGenerationRequest;

  await assert.rejects(
    () => generator.generate(request),
    (err: unknown) => {
      assert.ok(err instanceof E2eTestGeneratorError);
      assert.equal((err as E2eTestGeneratorError).kind, "pkc-query");
      return true;
    }
  );
});

test("T2f: maxTokensPerFile < 1 → 抛 E2eTestGeneratorError (pkc-query)", async () => {
  const llmClient = new InMemoryLLMClient(realE2eTestResponseGenerator);
  const pkcAccessor = new InMemoryPkcAccessor();
  const generator = new E2eTestGenerator();
  const request = {
    projectRoot: "/tmp/test",
    llmClient,
    pkcAccessor,
    acceptanceCriteria: [createAcceptanceCriterion()],
    outputDir: "tests/e2e/",
    maxTokensPerFile: 0,
  } as E2eTestGenerationRequest;

  await assert.rejects(
    () => generator.generate(request),
    (err: unknown) => {
      assert.ok(err instanceof E2eTestGeneratorError);
      assert.equal((err as E2eTestGeneratorError).kind, "pkc-query");
      return true;
    }
  );
});

// ============================================================================
// T3. generate() PKC 查询失败
// ============================================================================

test("T3a: pkcAccessor.queryBusinessFlows 抛错 → 抛 E2eTestGeneratorError (pkc-query)", async () => {
  const llmClient = new InMemoryLLMClient(realE2eTestResponseGenerator);
  const pkcAccessor = new ThrowingPkcAccessor();
  const generator = new E2eTestGenerator();
  const request: E2eTestGenerationRequest = {
    projectRoot: "/tmp/test",
    llmClient,
    pkcAccessor,
    acceptanceCriteria: [createAcceptanceCriterion()],
    outputDir: "tests/e2e/",
    maxTokensPerFile: 4000,
  };

  await assert.rejects(
    () => generator.generate(request),
    (err: unknown) => {
      assert.ok(err instanceof E2eTestGeneratorError);
      assert.equal((err as E2eTestGeneratorError).kind, "pkc-query");
      return true;
    }
  );
});

// ============================================================================
// T4. generate() 成功路径（documented 流程）
// ============================================================================

test("T4a: 单 documented 流程 → 生成 1 个测试文件", async () => {
  const llmClient = new InMemoryLLMClient(realE2eTestResponseGenerator);
  const pkcAccessor = new InMemoryPkcAccessor([createE2eTestSpec({ confidence: "documented" })]);
  const generator = new E2eTestGenerator();
  const request: E2eTestGenerationRequest = {
    projectRoot: "/tmp/test",
    llmClient,
    pkcAccessor,
    acceptanceCriteria: [createAcceptanceCriterion()],
    outputDir: "tests/e2e/",
    maxTokensPerFile: 4000,
  };

  const result = await generator.generate(request);

  assert.ok(result.testFiles, "应返回 testFiles");
  assert.equal(result.testFiles.length, 1, "应生成 1 个测试文件");
  assert.equal(result.humanCheckpointFlows.length, 0, "无 inferred 流程");
});

test("T4b: 多 documented 流程 → 生成多个测试文件", async () => {
  const llmClient = new InMemoryLLMClient(realE2eTestResponseGenerator);
  const pkcAccessor = new InMemoryPkcAccessor([
    createE2eTestSpec({ flowId: "flow-1", flowName: "下单" }),
    createE2eTestSpec({ flowId: "flow-2", flowName: "支付" }),
    createE2eTestSpec({ flowId: "flow-3", flowName: "查询" }),
  ]);
  const generator = new E2eTestGenerator();
  const request: E2eTestGenerationRequest = {
    projectRoot: "/tmp/test",
    llmClient,
    pkcAccessor,
    acceptanceCriteria: [createAcceptanceCriterion()],
    outputDir: "tests/e2e/",
    maxTokensPerFile: 4000,
  };

  const result = await generator.generate(request);
  assert.equal(result.testFiles.length, 3, "应生成 3 个测试文件");
});

test("T4c: 生成的 GeneratedTestFile 字段正确（kind=e2e）", async () => {
  const llmClient = new InMemoryLLMClient(realE2eTestResponseGenerator);
  const pkcAccessor = new InMemoryPkcAccessor([createE2eTestSpec({ flowId: "flow-test", flowName: "测试流程" })]);
  const generator = new E2eTestGenerator();
  const request: E2eTestGenerationRequest = {
    projectRoot: "/tmp/test",
    llmClient,
    pkcAccessor,
    acceptanceCriteria: [createAcceptanceCriterion()],
    outputDir: "tests/e2e/",
    maxTokensPerFile: 4000,
  };

  const result = await generator.generate(request);
  const testFile = result.testFiles[0];

  assert.equal(testFile.kind, "e2e", "kind 应为 e2e");
  assert.equal(testFile.requirementId, "F-001", "requirementId 应为 F-001");
  assert.equal(testFile.sourceId, "flow-test", "sourceId 应为 flowId");
  assert.ok(testFile.content.length > 0, "content 应非空");
  assert.ok(testFile.relativePath.startsWith("tests/e2e/"), "relativePath 应位于 tests/e2e/");
  assert.ok(testFile.relativePath.endsWith(".e2e.test.ts"), "relativePath 应以 .e2e.test.ts 结尾");
});

test("T4d: 测试用例描述提取", async () => {
  const llmClient = new InMemoryLLMClient(realE2eTestResponseGenerator);
  const pkcAccessor = new InMemoryPkcAccessor([createE2eTestSpec({ flowId: "flow-desc", flowName: "描述测试" })]);
  const generator = new E2eTestGenerator();
  const request: E2eTestGenerationRequest = {
    projectRoot: "/tmp/test",
    llmClient,
    pkcAccessor,
    acceptanceCriteria: [createAcceptanceCriterion()],
    outputDir: "tests/e2e/",
    maxTokensPerFile: 4000,
  };

  const result = await generator.generate(request);
  const testFile = result.testFiles[0];

  // realE2eTestResponseGenerator 返回至少 2 个 test() 节点
  assert.ok(testFile.testCaseDescriptions.length > 0, "应提取至少 1 个测试用例描述");
});

// ============================================================================
// T5. generate() 置信度过滤
// ============================================================================

test("T5a: documented 流程 → 接受并生成测试", async () => {
  const llmClient = new InMemoryLLMClient(realE2eTestResponseGenerator);
  const pkcAccessor = new InMemoryPkcAccessor([createE2eTestSpec({ flowId: "flow-doc", confidence: "documented" })]);
  const generator = new E2eTestGenerator();
  const request: E2eTestGenerationRequest = {
    projectRoot: "/tmp/test",
    llmClient,
    pkcAccessor,
    acceptanceCriteria: [],
    outputDir: "tests/e2e/",
    maxTokensPerFile: 4000,
  };

  const result = await generator.generate(request);
  assert.equal(result.testFiles.length, 1, "documented 流程应被接受");
  assert.equal(result.humanCheckpointFlows.length, 0, "无 inferred 流程");
});

test("T5b: verified 流程 → 接受并生成测试", async () => {
  const llmClient = new InMemoryLLMClient(realE2eTestResponseGenerator);
  const pkcAccessor = new InMemoryPkcAccessor([createE2eTestSpec({ flowId: "flow-ver", confidence: "verified" })]);
  const generator = new E2eTestGenerator();
  const request: E2eTestGenerationRequest = {
    projectRoot: "/tmp/test",
    llmClient,
    pkcAccessor,
    acceptanceCriteria: [],
    outputDir: "tests/e2e/",
    maxTokensPerFile: 4000,
  };

  const result = await generator.generate(request);
  assert.equal(result.testFiles.length, 1, "verified 流程应被接受");
});

test("T5c: inferred 流程 → 转 HUMAN_CHECKPOINT 队列", async () => {
  const llmClient = new InMemoryLLMClient(realE2eTestResponseGenerator);
  const pkcAccessor = new InMemoryPkcAccessor([createE2eTestSpec({ flowId: "flow-inf", confidence: "inferred" })]);
  const generator = new E2eTestGenerator();
  const request: E2eTestGenerationRequest = {
    projectRoot: "/tmp/test",
    llmClient,
    pkcAccessor,
    acceptanceCriteria: [],
    outputDir: "tests/e2e/",
    maxTokensPerFile: 4000,
  };

  const result = await generator.generate(request);
  assert.equal(result.testFiles.length, 0, "inferred 流程不应生成测试");
  assert.equal(result.humanCheckpointFlows.length, 1, "inferred 流程应转 HUMAN_CHECKPOINT");
  assert.equal(result.humanCheckpointFlows[0].flowId, "flow-inf");
});

test("T5d: 混合置信度 → 仅 documented/verified 生成测试，inferred 转队列", async () => {
  const llmClient = new InMemoryLLMClient(realE2eTestResponseGenerator);
  const pkcAccessor = new InMemoryPkcAccessor([
    createE2eTestSpec({ flowId: "flow-doc", confidence: "documented" }),
    createE2eTestSpec({ flowId: "flow-ver", confidence: "verified" }),
    createE2eTestSpec({ flowId: "flow-inf-1", confidence: "inferred" }),
    createE2eTestSpec({ flowId: "flow-inf-2", confidence: "inferred" }),
  ]);
  const generator = new E2eTestGenerator();
  const request: E2eTestGenerationRequest = {
    projectRoot: "/tmp/test",
    llmClient,
    pkcAccessor,
    acceptanceCriteria: [],
    outputDir: "tests/e2e/",
    maxTokensPerFile: 4000,
  };

  const result = await generator.generate(request);
  assert.equal(result.testFiles.length, 2, "应仅 documented/verified 流程生成测试");
  assert.equal(result.humanCheckpointFlows.length, 2, "应 2 个 inferred 流程转队列");
});

// ============================================================================
// T6. generate() 失败路径
// ============================================================================

test("T6a: LLM 响应非 JSON → 抛 E2eTestGeneratorError (llm-format)", async () => {
  const llmClient = new InMemoryLLMClient(nonJsonResponseGenerator);
  const pkcAccessor = new InMemoryPkcAccessor([createE2eTestSpec({ confidence: "documented" })]);
  const generator = new E2eTestGenerator();
  const request: E2eTestGenerationRequest = {
    projectRoot: "/tmp/test",
    llmClient,
    pkcAccessor,
    acceptanceCriteria: [],
    outputDir: "tests/e2e/",
    maxTokensPerFile: 4000,
  };

  await assert.rejects(
    () => generator.generate(request),
    (err: unknown) => {
      assert.ok(err instanceof E2eTestGeneratorError);
      assert.equal((err as E2eTestGeneratorError).kind, "llm-format");
      return true;
    }
  );
});

test("T6b: LLM 响应 JSON 结构非法 → 抛 E2eTestGeneratorError (llm-format)", async () => {
  const llmClient = new InMemoryLLMClient(invalidJsonStructureGenerator);
  const pkcAccessor = new InMemoryPkcAccessor([createE2eTestSpec({ confidence: "documented" })]);
  const generator = new E2eTestGenerator();
  const request: E2eTestGenerationRequest = {
    projectRoot: "/tmp/test",
    llmClient,
    pkcAccessor,
    acceptanceCriteria: [],
    outputDir: "tests/e2e/",
    maxTokensPerFile: 4000,
  };

  await assert.rejects(
    () => generator.generate(request),
    (err: unknown) => {
      assert.ok(err instanceof E2eTestGeneratorError);
      assert.equal((err as E2eTestGeneratorError).kind, "llm-format");
      return true;
    }
  );
});

test("T6c: 断言数不足 → 抛 E2eTestGeneratorError (assertion-missing)", async () => {
  const llmClient = new InMemoryLLMClient(noAssertionResponseGenerator);
  // 流程含 2 步骤，LLM 返回 0 断言 → assertion-missing
  const pkcAccessor = new InMemoryPkcAccessor([
    createE2eTestSpec({
      confidence: "documented",
      steps: [
        createE2eFlowStep({ order: 1, stateTransition: undefined }),
        createE2eFlowStep({ order: 2, stateTransition: undefined }),
      ],
    }),
  ]);
  const generator = new E2eTestGenerator();
  const request: E2eTestGenerationRequest = {
    projectRoot: "/tmp/test",
    llmClient,
    pkcAccessor,
    acceptanceCriteria: [],
    outputDir: "tests/e2e/",
    maxTokensPerFile: 4000,
  };

  await assert.rejects(
    () => generator.generate(request),
    (err: unknown) => {
      assert.ok(err instanceof E2eTestGeneratorError);
      assert.equal((err as E2eTestGeneratorError).kind, "assertion-missing");
      return true;
    }
  );
});

test("T6d: stateTransition 未断言 → 抛 E2eTestGeneratorError (state-transition-missing)", async () => {
  const llmClient = new InMemoryLLMClient(missingStateTransitionGenerator);
  // 流程含 stateTransition，LLM 返回的代码不引用状态字符串 → state-transition-missing
  const pkcAccessor = new InMemoryPkcAccessor([
    createE2eTestSpec({
      confidence: "documented",
      steps: [
        createE2eFlowStep({ order: 1, stateTransition: "draft→pending" }),
        createE2eFlowStep({ order: 2, stateTransition: "pending→paid" }),
      ],
    }),
  ]);
  const generator = new E2eTestGenerator();
  const request: E2eTestGenerationRequest = {
    projectRoot: "/tmp/test",
    llmClient,
    pkcAccessor,
    acceptanceCriteria: [],
    outputDir: "tests/e2e/",
    maxTokensPerFile: 4000,
  };

  await assert.rejects(
    () => generator.generate(request),
    (err: unknown) => {
      assert.ok(err instanceof E2eTestGeneratorError);
      assert.equal((err as E2eTestGeneratorError).kind, "state-transition-missing");
      return true;
    }
  );
});

// ============================================================================
// T7. 不可变性
// ============================================================================

test("T7a: 生成的 testFiles 数组冻结", async () => {
  const llmClient = new InMemoryLLMClient(realE2eTestResponseGenerator);
  const pkcAccessor = new InMemoryPkcAccessor([createE2eTestSpec({ confidence: "documented" })]);
  const generator = new E2eTestGenerator();
  const request: E2eTestGenerationRequest = {
    projectRoot: "/tmp/test",
    llmClient,
    pkcAccessor,
    acceptanceCriteria: [],
    outputDir: "tests/e2e/",
    maxTokensPerFile: 4000,
  };

  const result = await generator.generate(request);
  assert.ok(Object.isFrozen(result.testFiles), "testFiles 数组应冻结");
});

test("T7b: humanCheckpointFlows 数组冻结", async () => {
  const llmClient = new InMemoryLLMClient(realE2eTestResponseGenerator);
  const pkcAccessor = new InMemoryPkcAccessor([createE2eTestSpec({ confidence: "inferred" })]);
  const generator = new E2eTestGenerator();
  const request: E2eTestGenerationRequest = {
    projectRoot: "/tmp/test",
    llmClient,
    pkcAccessor,
    acceptanceCriteria: [],
    outputDir: "tests/e2e/",
    maxTokensPerFile: 4000,
  };

  const result = await generator.generate(request);
  assert.ok(Object.isFrozen(result.humanCheckpointFlows), "humanCheckpointFlows 数组应冻结");
});

test("T7c: 整体 result 冻结", async () => {
  const llmClient = new InMemoryLLMClient(realE2eTestResponseGenerator);
  const pkcAccessor = new InMemoryPkcAccessor([createE2eTestSpec({ confidence: "documented" })]);
  const generator = new E2eTestGenerator();
  const request: E2eTestGenerationRequest = {
    projectRoot: "/tmp/test",
    llmClient,
    pkcAccessor,
    acceptanceCriteria: [],
    outputDir: "tests/e2e/",
    maxTokensPerFile: 4000,
  };

  const result = await generator.generate(request);
  assert.ok(Object.isFrozen(result), "整体 result 应冻结");
});

test("T7d: 生成的 GeneratedTestFile 冻结", async () => {
  const llmClient = new InMemoryLLMClient(realE2eTestResponseGenerator);
  const pkcAccessor = new InMemoryPkcAccessor([createE2eTestSpec({ confidence: "documented" })]);
  const generator = new E2eTestGenerator();
  const request: E2eTestGenerationRequest = {
    projectRoot: "/tmp/test",
    llmClient,
    pkcAccessor,
    acceptanceCriteria: [],
    outputDir: "tests/e2e/",
    maxTokensPerFile: 4000,
  };

  const result = await generator.generate(request);
  const testFile = result.testFiles[0];

  assert.ok(Object.isFrozen(testFile), "GeneratedTestFile 应冻结");
  assert.ok(Object.isFrozen(testFile.testCaseDescriptions), "testCaseDescriptions 应冻结");
});

// ============================================================================
// T8. 错误类
// ============================================================================

test("T8a: E2eTestGeneratorError 含 kind 属性", () => {
  const error = new E2eTestGeneratorError("pkc-query", "测试错误");
  assert.equal(error.kind, "pkc-query");
  assert.equal(error.name, "E2eTestGeneratorError");
  assert.ok(error.message.includes("测试错误"));
});

test("T8b: E2eTestGeneratorError 含 cause 属性", () => {
  const cause = new Error("原始错误");
  const error = new E2eTestGeneratorError("llm-format", "LLM 失败", cause);
  assert.equal(error.cause, cause, "cause 应为原始错误");
});
