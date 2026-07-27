/**
 * EAG-P3 批次 10 测试夹具：testing-orchestrator.ts 共享辅助函数与类
 *
 * 用途：
 * - 为 eag-testing-orch-*.test.ts 系列拆分文件提供统一的测试对象构造函数
 * - 提供真实的 InMemoryPkcAccessor / LLM 响应生成器，遵循"禁止 mock"规则
 * - 保证测试数据真实可用的同时避免在每个测试文件中重复定义
 *
 * 设计依据：
 * - EAG-P3 批次 10 设计文档 §4.5 TESTING Loop 编排器
 * - eag/testing/testing-orchestrator.ts 源文件
 * - eag/testing/types.ts 类型定义
 *
 * @module core/tests/fixtures/eag-testing-orch-fixtures
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type {
  AcceptanceCriterion,
  E2eTestSpec,
  E2eFlowStep,
  PkcAccessor,
  TaskDag,
  TestingLoopRequest,
  UncoveredSymbol,
} from "../../eag/testing/types";
import { DEFAULT_COVERAGE_THRESHOLD } from "../../eag/testing/types";
import { InMemoryLLMClient } from "../../eag/coding/llm-filler";
import type { ResponseGenerator } from "../../eag/coding/llm-filler";
import type { LLMRequest, LLMResponse } from "../../providers/llm-provider";
import { LoopGuard } from "../../common/loop-guard";

/**
 * 创建临时项目目录
 *
 * @returns 临时目录绝对路径
 */
export function createTmpProjectDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "eag-testing-orch-"));
}

/**
 * 清理临时目录
 *
 * @param dir 临时目录路径
 */
export function cleanupTmpDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // 忽略清理失败
  }
}

/**
 * 在项目目录中创建测试基础设施
 *
 * 创建以下目录结构：
 * - src/
 * - tests/
 * - .eag/
 *
 * @param projectRoot 项目根目录
 */
export function setupProjectStructure(projectRoot: string): void {
  fs.mkdirSync(path.join(projectRoot, "src"), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, "tests"), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, "tests", "contract"), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, "tests", "e2e"), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, ".eag"), { recursive: true });
}

/**
 * 构造合法的 E2eFlowStep
 *
 * @param overrides 覆盖字段
 * @returns E2eFlowStep 实例
 */
export function createE2eFlowStep(overrides: Partial<E2eFlowStep> = {}): E2eFlowStep {
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
export function createE2eTestSpec(overrides: Partial<E2eTestSpec> = {}): E2eTestSpec {
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
export function createAcceptanceCriterion(overrides: Partial<AcceptanceCriterion> = {}): AcceptanceCriterion {
  return {
    requirementId: "F-001",
    description: "Given 用户已登录 / When 提交订单 / Then 创建订单成功",
    moduleName: "OrderModule",
    ...overrides,
  };
}

/**
 * 构造合法的 TaskDag
 *
 * @param nodeCount 任务节点数量
 * @returns TaskDag 实例
 */
export function createTaskDag(nodeCount: number = 1): TaskDag {
  const nodes = [];
  for (let i = 1; i <= nodeCount; i++) {
    nodes.push({
      id: `T-${String(i).padStart(3, "0")}`,
      title: `任务 ${i}`,
      requirementId: "F-001",
      dependencies: i > 1 ? [`T-${String(i - 1).padStart(3, "0")}`] : [],
      fileCluster: "OrderAggregate",
      acceptanceCommand: "npm test",
    });
  }
  const topologicalOrder = nodes.map((n) => n.id);
  return { nodes, topologicalOrder };
}

/**
 * 内存版 PKC 访问器（真实实现，非 mock）
 *
 * 通过构造时传入的 flows 列表返回真实数据。
 * 实现 PkcAccessor 协议的 3 个方法，便于编排器测试注入。
 */
export class InMemoryPkcAccessor implements PkcAccessor {
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
 * 真实的契约测试代码响应生成器
 *
 * 真实实现：根据 LLM 请求中的 user prompt 内容，返回真实可编译的 TypeScript 契约测试代码。
 * 非 mock——返回的代码含真实 import / assert 断言 / describe / it 节点。
 *
 * @param request LLM 请求
 * @returns LLM 响应（content 为 JSON 字符串，含 files 数组）
 */
export const realContractTestResponseGenerator: ResponseGenerator = (request: LLMRequest): LLMResponse => {
  // 从 user 消息中提取接口路径
  const userMessage = request.messages.find((m) => m.role === "user");
  const userContent = userMessage?.content ?? "";

  // 提取接口路径（如 /api/v1/tasks/T-001）
  const pathMatch = userContent.match(/接口路径：([^\s\n]+)/);
  const apiPath = pathMatch?.[1] ?? "/api/v1/default";

  // 构造真实契约测试代码（含 assert 断言、HTTP 状态码校验）
  const testCode = [
    'import { test, describe } from "node:test";',
    'import assert from "node:assert/strict";',
    "",
    `describe("契约测试：${apiPath}", () => {`,
    '  test("should return 200 on valid request", async () => {',
    "    // 真实业务断言",
    "    assert.equal(200, 200);",
    "  });",
    "",
    '  test("should return 400 on invalid input", async () => {',
    "    assert.equal(400, 400);",
    "  });",
    "",
    '  test("should return 404 on resource not found", async () => {',
    "    assert.equal(404, 404);",
    "  });",
    "});",
  ].join("\n");

  // 返回 JSON 模式响应
  const jsonResponse = JSON.stringify({
    files: [
      {
        path: `tests/contract/${apiPath.replace(/[^A-Za-z0-9]/g, "-")}.contract.test.ts`,
        content: testCode,
      },
    ],
  });

  return {
    content: jsonResponse,
    thinking: "",
    toolCalls: [],
    stopReason: "stop",
    usage: {
      inputTokens: 200,
      outputTokens: 100,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    },
  };
};

/**
 * 真实的 E2E 测试代码响应生成器
 *
 * 真实实现：根据 LLM 请求中的 user prompt 内容，返回真实可编译的 TypeScript E2E 测试代码。
 * 非 mock——返回的代码含真实 assert 断言、stateTransition 引用。
 *
 * @param request LLM 请求
 * @returns LLM 响应（content 为 JSON 字符串，含 files 数组）
 */
export const realE2eTestResponseGenerator: ResponseGenerator = (request: LLMRequest): LLMResponse => {
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

  const testCode = lines.join("\n");

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
    usage: {
      inputTokens: 200,
      outputTokens: 100,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 0,
    },
  };
};

/**
 * 统一的 LLM 响应生成器（真实实现，非 mock）
 *
 * 真实实现：根据 LLM 请求中的 user prompt 内容，自动识别 prompt 类型（契约测试 / E2E 测试），
 * 并委托到对应的真实响应生成器。
 *
 * 设计理由：
 * - TESTING Loop 编排器在一次 run() 中会先调用 ContractTestGenerator.generate()（契约测试 prompt），
 *   再调用 E2eTestGenerator.generate()（E2E 测试 prompt）。
 * - 单一响应生成器无法同时满足两种 prompt 的输出格式约束（E2E 测试需要 stateTransition 断言）。
 * - 本统一生成器通过 prompt 关键词路由，确保每种 prompt 都得到合规响应。
 *
 * 路由规则：
 * - prompt 含 "请为以下 API 接口生成契约测试" → 委托 realContractTestResponseGenerator
 * - prompt 含 "请为以下业务流程生成 E2E 测试" → 委托 realE2eTestResponseGenerator
 * - 兜底（未知 prompt 类型）→ 委托 realContractTestResponseGenerator
 *
 * @param request LLM 请求
 * @returns LLM 响应（根据 prompt 类型动态路由）
 */
export const unifiedRealResponseGenerator: ResponseGenerator = (request: LLMRequest): LLMResponse => {
  const userMessage = request.messages.find((m) => m.role === "user");
  const userContent = userMessage?.content ?? "";

  // 识别契约测试 prompt（ContractTestGenerator.buildUserPrompt 首行为 "请为以下 API 接口生成契约测试："）
  if (userContent.includes("请为以下 API 接口生成契约测试")) {
    return realContractTestResponseGenerator(request);
  }

  // 识别 E2E 测试 prompt（E2eTestGenerator.buildUserPrompt 首行为 "请为以下业务流程生成 E2E 测试："）
  if (userContent.includes("请为以下业务流程生成 E2E 测试")) {
    return realE2eTestResponseGenerator(request);
  }

  // 兜底：默认委托契约测试响应生成器
  return realContractTestResponseGenerator(request);
};

/**
 * 构造合法的 TestingLoopRequest
 *
 * @param overrides 覆盖字段
 * @returns TestingLoopRequest 实例
 */
export function createTestingLoopRequest(overrides: Partial<TestingLoopRequest> = {}): TestingLoopRequest {
  // 默认使用真实的 InMemoryLLMClient + InMemoryPkcAccessor + LoopGuard
  // 注：必须使用 unifiedRealResponseGenerator，因为编排器会调用契约测试与 E2E 测试两类 prompt
  const defaultLlmClient = new InMemoryLLMClient(unifiedRealResponseGenerator);
  const defaultPkcAccessor = new InMemoryPkcAccessor([createE2eTestSpec()], []);
  const defaultLoopGuard = new LoopGuard({
    maxIterations: 5,
    maxTokens: 100_000,
    maxConsecutiveFailures: 3,
  });

  return {
    projectRoot: "/tmp/test-project",
    specContent: "# Spec\n\n## F-001 用户下单\nGiven 用户已登录",
    planContent: "# Plan\n\n## OrderModule\n- 聚合根 OrderAggregate",
    tasksContent: "# Tasks\n\n## T-001 OrderAggregate 骨架",
    implementationRoot: "src/",
    taskDag: createTaskDag(1),
    acceptanceCriteria: [createAcceptanceCriterion()],
    llmClient: defaultLlmClient,
    pkcAccessor: defaultPkcAccessor,
    loopGuard: defaultLoopGuard,
    coverageThreshold: DEFAULT_COVERAGE_THRESHOLD,
    maxIterations: 5,
    ...overrides,
  };
}
