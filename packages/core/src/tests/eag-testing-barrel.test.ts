/**
 * EAG-P3 批次 10 集成测试：TESTING Loop 子模块群 Barrel 导出（index.ts）
 *
 * 测试范围（对齐设计文档 §2 目录树 eag/testing/index.ts）：
 * - T1. 数据模型与常量导出（types.ts）
 *   - T1a. 数据模型类型可用（type-only import）
 *   - T1b. 默认配置常量导出（DEFAULT_COVERAGE_THRESHOLD / DEFAULT_HIGH_RISK_TOP_N 等）
 *   - T1c. 工厂函数导出（createTestingLoopRequest / createContractTestSpec 等）
 *   - T1d. 错误类导出（TestingLoopRequestError）
 * - T2. 子模块类与工厂函数导出
 *   - T2a. ContractTestGenerator / ContractTestGeneratorError / OpenApiSpecParser / TsSignatureExtractor 类导出
 *   - T2b. E2eTestGenerator / E2eTestGeneratorError 类导出
 *   - T2c. CoverageGate / CoverageGateError / C8ReportParser 类导出
 *   - T2d. BrownfieldContractGuard / BrownfieldContractGuardError 类导出
 *   - T2e. TestingOrchestrator / TestingOrchestratorError 类导出
 *   - T2f. AssertionDensityChecker / TestNamingChecker / CoverageGapChecker 类导出
 *   - T2g. 工厂函数导出（createDefaultContractTestGenerator / createDefaultE2eTestGenerator 等）
 * - T3. Barrel 跨模块集成测试（端到端导入链路）
 *   - T3a. 从 barrel 导入 TestingOrchestrator + CoverageGate + InMemoryLLMClient（来自 coding 模块）端到端可运行
 *   - T3b. 从 barrel 导入 3 个 staticCheckers + DEFAULT_TEST_QUALITY_CHECKERS 注册表可访问
 *   - T3c. 从 barrel 导入常量（DEFAULT_COVERAGE_THRESHOLD / DEFAULT_MAX_TESTING_ITERATIONS）值正确
 * - T4. 完整端到端集成测试
 *   - T4a. 真实 InMemoryLLMClient + InMemoryPkcAccessor + LoopGuard + TestingOrchestrator 端到端运行
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止 mock，使用真实实现（InMemoryLLMClient + InMemoryPkcAccessor + LoopGuard 真实实现）
 * - 使用真实 fs I/O（mkdtempSync + try/finally 清理）
 * - 中文详细注释
 *
 * @module core/tests/eag-testing-barrel
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ============================================================================
// 从 barrel 导入全部公共 API（验证 barrel 导出链路完整性）
// ============================================================================

// 1. 数据模型导出（types.ts）
import {
  TEST_FILE_KINDS,
  E2E_FLOW_CONFIDENCES,
  DEFAULT_COVERAGE_THRESHOLD,
  COVERAGE_FAILED_DIMENSIONS,
  BREAKING_CHANGE_KINDS,
  TESTING_LOOP_FINAL_STATUSES,
  TEST_QUALITY_SEVERITIES,
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
  TestingLoopRequestError,
  createTestingLoopRequest,
  createContractTestSpec,
  createE2eTestSpec,
  createGeneratedTestFile,
} from "../eag/testing";

// 2. 契约测试生成器导出（contract-test-generator.ts）
import {
  ContractTestGenerator,
  ContractTestGeneratorError,
  OpenApiSpecParser,
  TsSignatureExtractor,
  createDefaultContractTestGenerator,
  createOpenApiSpecParser,
  createTsSignatureExtractor,
  DEFAULT_CONTRACT_TEST_TEMPLATES,
} from "../eag/testing";

// 3. E2E 测试生成器导出（e2e-test-generator.ts）
import { E2eTestGenerator, E2eTestGeneratorError, createDefaultE2eTestGenerator } from "../eag/testing";

// 4. 覆盖率门禁导出（coverage-gate.ts）
import {
  CoverageGate,
  CoverageGateError,
  C8ReportParser,
  createDefaultCoverageGate,
  createC8ReportParser,
  isC8Available,
} from "../eag/testing";

// 5. 既有契约保护判定器导出（brownfield-contract-guard.ts）
import {
  BrownfieldContractGuard,
  BrownfieldContractGuardError,
  createDefaultBrownfieldContractGuard,
  DEFAULT_EXISTING_CONTRACTS_RELATIVE_PATH,
} from "../eag/testing";

// 6. TESTING Loop 编排器导出（testing-orchestrator.ts）
import { TestingOrchestrator, TestingOrchestratorError, createDefaultTestingOrchestrator } from "../eag/testing";

// 7. 测试质量静态判定器导出（static-checkers/）
import {
  AssertionDensityChecker,
  TestNamingChecker,
  CoverageGapChecker,
  DEFAULT_TEST_QUALITY_CHECKERS,
  getRegisteredCheckerIds,
  getCheckerById,
  runAllCheckers,
} from "../eag/testing";

// 跨模块导入（InMemoryLLMClient 来自 coding 模块）
import { InMemoryLLMClient } from "../eag/coding/llm-filler";
import type { ResponseGenerator } from "../eag/coding/llm-filler";
import type { LLMRequest, LLMResponse } from "../providers/llm-provider";
import { LoopGuard } from "../common/loop-guard";

// 类型导入（验证 type-only export 链路）
import type {
  TestFileKind,
  GeneratedTestFile,
  ContractTestSpec,
  E2eFlowConfidence,
  E2eTestSpec,
  E2eFlowStep,
  CoverageThreshold,
  UncoveredSymbol,
  CoverageFailedDimension,
  CoverageReport,
  AcceptanceCriterion,
  PkcAccessor,
  TestingLoopFinalStatus,
  TestingLoopRequest,
  TestingLoopResult,
  BrownfieldContractGuardRequest,
  BreakingChangeKind,
  BreakingChange,
  CompatibleChange,
  ContractCompatibilityReport,
  TestQualityChecker,
  TestQualitySeverity,
  TestQualityContext,
  TestQualityResult,
  TestQualityViolation,
  LogCallback,
  LoopEvent,
  ContractTestGenerationRequest,
  E2eTestGenerationRequest,
  E2eTestGenerationResult,
  CoverageGateRequest,
  C8ParsedReport,
  BrownfieldContractGuardErrorKind,
  TestingOrchestratorErrorKind,
  GateG6Result,
  GateG7Result,
  GateG6Context,
  GateG7Context,
} from "../eag/testing";

// ============================================================================
// 辅助函数：构造测试 fixture
// ============================================================================

/**
 * 创建临时项目目录
 *
 * @returns 临时目录绝对路径
 */
function createTmpProjectDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "eag-testing-barrel-"));
}

/**
 * 清理临时目录
 *
 * @param dir 临时目录路径
 */
function cleanupTmpDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // 忽略清理失败
  }
}

/**
 * 在项目目录中创建测试基础设施
 *
 * @param projectRoot 项目根目录
 */
function setupProjectStructure(projectRoot: string): void {
  fs.mkdirSync(path.join(projectRoot, "src"), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, "tests"), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, "tests", "contract"), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, "tests", "e2e"), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, ".eag"), { recursive: true });
}

/**
 * 内存版 PKC 访问器（真实实现，非 mock）
 *
 * 实现 PkcAccessor 协议的 3 个方法，便于 barrel 集成测试注入。
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
   * @param _projectRoot 项目根目录
   * @param _topN Top-N
   * @returns 构造时注入的 hotspots 列表
   */
  async queryRiskHotspots(_projectRoot: string, _topN?: number): Promise<ReadonlyArray<UncoveredSymbol>> {
    return this.hotspots;
  }

  /**
   * 查询 L1 全局视野
   *
   * @param _projectRoot 项目根目录
   * @returns 空对象
   */
  async queryL1GlobalView(_projectRoot: string): Promise<Readonly<Record<string, unknown>>> {
    return {};
  }
}

/**
 * 真实的契约测试代码响应生成器
 *
 * 非 mock——返回的代码含真实 import / assert 断言 / describe / it 节点。
 *
 * @param request LLM 请求
 * @returns LLM 响应
 */
const realContractTestResponseGenerator: ResponseGenerator = (request: LLMRequest): LLMResponse => {
  const userMessage = request.messages.find((m) => m.role === "user");
  const userContent = userMessage?.content ?? "";
  const pathMatch = userContent.match(/接口路径：([^\s\n]+)/);
  const apiPath = pathMatch?.[1] ?? "/api/v1/default";

  const testCode = [
    'import { test, describe } from "node:test";',
    'import assert from "node:assert/strict";',
    "",
    `describe("契约测试：${apiPath}", () => {`,
    '  test("should return 200 on valid request", async () => {',
    "    assert.equal(200, 200);",
    "  });",
    '  test("should return 400 on invalid input", async () => {',
    "    assert.equal(400, 400);",
    "  });",
    "});",
  ].join("\n");

  return {
    content: JSON.stringify({
      files: [
        {
          path: `tests/contract/${apiPath.replace(/[^A-Za-z0-9]/g, "-")}.contract.test.ts`,
          content: testCode,
        },
      ],
    }),
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
 * 非 mock——返回的代码含真实 assert 断言、stateTransition 引用。
 *
 * @param request LLM 请求
 * @returns LLM 响应
 */
const realE2eTestResponseGenerator: ResponseGenerator = (request: LLMRequest): LLMResponse => {
  const userMessage = request.messages.find((m) => m.role === "user");
  const userContent = userMessage?.content ?? "";
  const flowNameMatch = userContent.match(/流程名称：(\S+)/);
  const flowName = flowNameMatch?.[1] ?? "未知流程";
  const stateTransitionMatches = userContent.matchAll(/状态转换：([^\n]+)/g);
  const stateTransitions: string[] = [];
  for (const match of stateTransitionMatches) {
    stateTransitions.push(match[1].trim());
  }

  const lines: string[] = [
    'import { test } from "node:test";',
    'import assert from "node:assert/strict";',
    "",
    `test("should complete step 1 of flow: ${flowName}", async () => {`,
    "  assert.equal(true, true);",
    "});",
    `test("should complete step 2 of flow: ${flowName}", async () => {`,
    "  assert.ok(true);",
    "});",
  ];

  if (stateTransitions.length > 0) {
    lines.push(`test("should verify state transitions for ${flowName}", async () => {`);
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
      lines.push(`  assert.ok("${state}" !== "");`);
    }
    lines.push("});");
  }

  return {
    content: JSON.stringify({
      files: [
        {
          path: `tests/e2e/${flowName.replace(/[^A-Za-z0-9]/g, "-")}.e2e.test.ts`,
          content: lines.join("\n"),
        },
      ],
    }),
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
const unifiedRealResponseGenerator: ResponseGenerator = (request: LLMRequest): LLMResponse => {
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

// ============================================================================
// T1. 数据模型与常量导出（types.ts）
// ============================================================================

test("T1a: 数据模型类型可用（type-only import）", () => {
  // 类型导出验证：构造符合类型签名的对象（编译期检查）
  const testFileKind: TestFileKind = "contract";
  assert.equal(testFileKind, "contract");

  const flowConfidence: E2eFlowConfidence = "documented";
  assert.equal(flowConfidence, "documented");

  const failedDimension: CoverageFailedDimension = "lines";
  assert.equal(failedDimension, "lines");

  const finalStatus: TestingLoopFinalStatus = "success";
  assert.equal(finalStatus, "success");

  const breakingChangeKind: BreakingChangeKind = "api-removed";
  assert.equal(breakingChangeKind, "api-removed");

  const severity: TestQualitySeverity = "blocker";
  assert.equal(severity, "blocker");

  // 验证类型断言（仅在类型存在时编译通过）

  const _unused:
    | GeneratedTestFile
    | ContractTestSpec
    | E2eTestSpec
    | E2eFlowStep
    | CoverageThreshold
    | UncoveredSymbol
    | CoverageReport
    | AcceptanceCriterion
    | PkcAccessor
    | TestingLoopRequest
    | TestingLoopResult
    | BrownfieldContractGuardRequest
    | BreakingChange
    | CompatibleChange
    | ContractCompatibilityReport
    | TestQualityChecker
    | TestQualityContext
    | TestQualityResult
    | TestQualityViolation
    | LogCallback
    | LoopEvent
    | ContractTestGenerationRequest
    | E2eTestGenerationRequest
    | E2eTestGenerationResult
    | CoverageGateRequest
    | C8ParsedReport
    | BrownfieldContractGuardErrorKind
    | TestingOrchestratorErrorKind
    | GateG6Result
    | GateG7Result
    | GateG6Context
    | GateG7Context = null as never;
});

test("T1b: 默认配置常量导出（DEFAULT_COVERAGE_THRESHOLD / DEFAULT_HIGH_RISK_TOP_N 等）", () => {
  // 验证常量值正确性
  assert.equal(DEFAULT_COVERAGE_THRESHOLD.lines, 80, "行覆盖率阈值应为 80");
  assert.equal(DEFAULT_COVERAGE_THRESHOLD.branches, 70, "分支覆盖率阈值应为 70");
  assert.equal(DEFAULT_COVERAGE_THRESHOLD.functions, 85, "函数覆盖率阈值应为 85");
  assert.equal(DEFAULT_COVERAGE_THRESHOLD.highRiskSymbols, 100, "高风险符号覆盖率阈值应为 100");

  assert.equal(DEFAULT_MAX_TESTING_ITERATIONS, 5, "默认最大迭代次数应为 5");
  assert.equal(DEFAULT_MAX_TOKENS_PER_TEST_FILE, 4000, "默认单文件 token 上限应为 4000");
  assert.equal(DEFAULT_MAX_TOKENS_PER_TEST_LLM_CALL, 8000, "默认单次 LLM 调用 token 上限应为 8000");
  assert.equal(DEFAULT_TEST_GENERATION_TEMPERATURE, 0.2, "默认生成温度应为 0.2");
  assert.equal(DEFAULT_CONTRACT_TEST_OUTPUT_DIR, "tests/contract/", "契约测试输出目录应为 tests/contract/");
  assert.equal(DEFAULT_E2E_TEST_OUTPUT_DIR, "tests/e2e/", "E2E 测试输出目录应为 tests/e2e/");
  assert.equal(DEFAULT_INTEGRATION_TEST_OUTPUT_DIR, "tests/integration/", "集成测试输出目录应为 tests/integration/");
  assert.equal(DEFAULT_HIGH_RISK_TOP_N, 10, "高风险符号 Top-N 应为 10");
  assert.equal(COVERAGE_CONSECUTIVE_FAILURE_THRESHOLD, 2, "覆盖率连续失败阈值应为 2");
  assert.equal(HIGH_RISK_SCORE_THRESHOLD, 0.7, "高风险符号评分阈值应为 0.7");
  assert.equal(MIN_ASSERTIONS_PER_TEST_CASE, 1, "最小断言密度应为 1");

  // 验证常量集合
  assert.deepEqual(
    [...TEST_FILE_KINDS],
    ["contract", "e2e", "integration", "compliance", "regression"],
    "TEST_FILE_KINDS 应含全部 5 种测试文件类型"
  );
  assert.deepEqual(
    [...E2E_FLOW_CONFIDENCES],
    ["documented", "verified", "inferred"],
    "E2E_FLOW_CONFIDENCES 应含全部 3 种置信度"
  );
  assert.deepEqual(
    [...COVERAGE_FAILED_DIMENSIONS],
    ["lines", "branches", "functions", "highRiskSymbols"],
    "COVERAGE_FAILED_DIMENSIONS 应含全部 4 种失败维度"
  );
  assert.deepEqual(
    [...BREAKING_CHANGE_KINDS],
    ["api-removed", "required-field-added", "field-type-changed", "response-field-removed"],
    "BREAKING_CHANGE_KINDS 应含全部 4 种 breaking change 类型"
  );
  assert.deepEqual(
    [...TESTING_LOOP_FINAL_STATUSES],
    ["success", "human_checkpoint", "stop_failure"],
    "TESTING_LOOP_FINAL_STATUSES 应含全部 3 种最终状态"
  );
  assert.deepEqual([...TEST_QUALITY_SEVERITIES], ["blocker", "warning"], "TEST_QUALITY_SEVERITIES 应含全部 2 种严重级");

  // 验证 TESTING_DEFAULTS 汇总对象
  assert.equal(TESTING_DEFAULTS.maxTestingIterations, 5);
  assert.equal(TESTING_DEFAULTS.maxTokensPerTestFile, 4000);
  assert.equal(TESTING_DEFAULTS.maxTokensPerTestLlmCall, 8000);
  assert.equal(TESTING_DEFAULTS.testGenerationTemperature, 0.2);
  assert.equal(TESTING_DEFAULTS.contractTestOutputDir, "tests/contract/");
  assert.equal(TESTING_DEFAULTS.e2eTestOutputDir, "tests/e2e/");
  assert.equal(TESTING_DEFAULTS.integrationTestOutputDir, "tests/integration/");
  assert.equal(TESTING_DEFAULTS.highRiskTopN, 10);
  assert.equal(TESTING_DEFAULTS.coverageConsecutiveFailureThreshold, 2);
  assert.equal(TESTING_DEFAULTS.highRiskScoreThreshold, 0.7);
  assert.equal(TESTING_DEFAULTS.minAssertionsPerTestCase, 1);

  // 验证常量冻结
  assert.ok(Object.isFrozen(DEFAULT_COVERAGE_THRESHOLD), "DEFAULT_COVERAGE_THRESHOLD 应冻结");
  assert.ok(Object.isFrozen(TEST_FILE_KINDS), "TEST_FILE_KINDS 应冻结");
  assert.ok(Object.isFrozen(TESTING_DEFAULTS), "TESTING_DEFAULTS 应冻结");
});

test("T1c: 工厂函数导出（createTestingLoopRequest / createContractTestSpec 等）", () => {
  // 验证工厂函数可调用
  const request = createTestingLoopRequest({
    projectRoot: "/tmp/test-project",
    specContent: "# Spec",
    planContent: "# Plan",
    tasksContent: "# Tasks",
    implementationRoot: "src/",
    taskDag: { nodes: [], topologicalOrder: [] },
    acceptanceCriteria: [],
    llmClient: new InMemoryLLMClient(),
    pkcAccessor: new InMemoryPkcAccessor(),
    loopGuard: new LoopGuard(),
    coverageThreshold: DEFAULT_COVERAGE_THRESHOLD,
    maxIterations: 5,
  });
  assert.ok(request, "createTestingLoopRequest 应返回对象");
  assert.ok(Object.isFrozen(request), "createTestingLoopRequest 应返回冻结对象");

  const spec = createContractTestSpec({
    path: "/api/v1/test",
    method: "GET",
    responseSchemas: { "200": { type: "object" } },
    requirementId: "F-001",
    boundaryCases: [],
  });
  assert.ok(spec, "createContractTestSpec 应返回对象");
  assert.equal(spec.method, "GET");
  assert.ok(Object.isFrozen(spec), "createContractTestSpec 应返回冻结对象");

  const e2eSpec = createE2eTestSpec({
    flowId: "flow-001",
    flowName: "测试流程",
    steps: [],
    userStory: "Given / When / Then",
    requirementId: "F-001",
    confidence: "documented",
  });
  assert.ok(e2eSpec, "createE2eTestSpec 应返回对象");
  assert.ok(Object.isFrozen(e2eSpec), "createE2eTestSpec 应返回冻结对象");

  const testFile = createGeneratedTestFile({
    relativePath: "tests/test.ts",
    content: "test code",
    kind: "contract",
    requirementId: "F-001",
    sourceId: "/api/v1/test",
    testCaseCount: 1,
    testCaseDescriptions: ["test case 1"],
  });
  assert.ok(testFile, "createGeneratedTestFile 应返回对象");
  assert.ok(Object.isFrozen(testFile), "createGeneratedTestFile 应返回冻结对象");
});

test("T1d: 错误类导出（TestingLoopRequestError）", () => {
  const error = new TestingLoopRequestError("field", "value", "reason");
  assert.ok(error instanceof TestingLoopRequestError);
  assert.ok(error instanceof Error);
  assert.equal(error.field, "field");
  assert.equal(error.value, "value");
  assert.equal(error.reason, "reason");
  assert.equal(error.name, "TestingLoopRequestError");
});

// ============================================================================
// T2. 子模块类与工厂函数导出
// ============================================================================

test("T2a: ContractTestGenerator / ContractTestGeneratorError / OpenApiSpecParser / TsSignatureExtractor 类导出", () => {
  // 验证类可实例化
  const generator = new ContractTestGenerator();
  assert.ok(generator instanceof ContractTestGenerator);

  const parser = new OpenApiSpecParser();
  assert.ok(parser instanceof OpenApiSpecParser);

  const extractor = new TsSignatureExtractor();
  assert.ok(extractor instanceof TsSignatureExtractor);

  // 验证错误类
  const error = new ContractTestGeneratorError("file-io", "测试错误");
  assert.ok(error instanceof ContractTestGeneratorError);
  assert.ok(error instanceof Error);

  // 验证工厂函数
  const defaultGenerator = createDefaultContractTestGenerator();
  assert.ok(defaultGenerator instanceof ContractTestGenerator);

  const defaultParser = createOpenApiSpecParser();
  assert.ok(defaultParser instanceof OpenApiSpecParser);

  const defaultExtractor = createTsSignatureExtractor();
  assert.ok(defaultExtractor instanceof TsSignatureExtractor);

  // 验证模板常量
  assert.ok(DEFAULT_CONTRACT_TEST_TEMPLATES, "DEFAULT_CONTRACT_TEST_TEMPLATES 应非空");
});

test("T2b: E2eTestGenerator / E2eTestGeneratorError 类导出", () => {
  const generator = new E2eTestGenerator();
  assert.ok(generator instanceof E2eTestGenerator);

  const error = new E2eTestGeneratorError("pkc-query", "测试错误");
  assert.ok(error instanceof E2eTestGeneratorError);
  assert.ok(error instanceof Error);

  const defaultGenerator = createDefaultE2eTestGenerator();
  assert.ok(defaultGenerator instanceof E2eTestGenerator);
});

test("T2c: CoverageGate / CoverageGateError / C8ReportParser 类导出", () => {
  const pkcAccessor = new InMemoryPkcAccessor();
  const gate = new CoverageGate(pkcAccessor);
  assert.ok(gate instanceof CoverageGate);

  const parser = new C8ReportParser();
  assert.ok(parser instanceof C8ReportParser);

  const error = new CoverageGateError("c8-spawn", "测试错误");
  assert.ok(error instanceof CoverageGateError);
  assert.ok(error instanceof Error);

  const defaultGate = createDefaultCoverageGate(pkcAccessor);
  assert.ok(defaultGate instanceof CoverageGate);

  const defaultParser = createC8ReportParser();
  assert.ok(defaultParser instanceof C8ReportParser);

  // 验证 isC8Available 函数
  assert.equal(typeof isC8Available(), "boolean", "isC8Available 应返回 boolean");
});

test("T2d: BrownfieldContractGuard / BrownfieldContractGuardError 类导出", () => {
  const guard = new BrownfieldContractGuard();
  assert.ok(guard instanceof BrownfieldContractGuard);

  const error = new BrownfieldContractGuardError("file-not-found", "测试错误");
  assert.ok(error instanceof BrownfieldContractGuardError);
  assert.ok(error instanceof Error);

  const defaultGuard = createDefaultBrownfieldContractGuard();
  assert.ok(defaultGuard instanceof BrownfieldContractGuard);

  // 验证默认路径常量
  assert.equal(
    DEFAULT_EXISTING_CONTRACTS_RELATIVE_PATH,
    ".eag/existing-contracts.json",
    "默认既有契约文件路径应为 .eag/existing-contracts.json"
  );
});

test("T2e: TestingOrchestrator / TestingOrchestratorError 类导出", () => {
  const pkcAccessor = new InMemoryPkcAccessor();
  const coverageGate = new CoverageGate(pkcAccessor);
  const orchestrator = new TestingOrchestrator({ coverageGate });
  assert.ok(orchestrator instanceof TestingOrchestrator);

  const error = new TestingOrchestratorError("request-invalid", "测试错误");
  assert.ok(error instanceof TestingOrchestratorError);
  assert.ok(error instanceof Error);

  const defaultOrchestrator = createDefaultTestingOrchestrator(coverageGate);
  assert.ok(defaultOrchestrator instanceof TestingOrchestrator);
});

test("T2f: AssertionDensityChecker / TestNamingChecker / CoverageGapChecker 类导出", () => {
  const assertionChecker = new AssertionDensityChecker();
  assert.ok(assertionChecker instanceof AssertionDensityChecker);

  const namingChecker = new TestNamingChecker();
  assert.ok(namingChecker instanceof TestNamingChecker);

  const coverageGapChecker = new CoverageGapChecker();
  assert.ok(coverageGapChecker instanceof CoverageGapChecker);
});

test("T2g: staticCheckers 注册表与工具函数导出", () => {
  // 验证 DEFAULT_TEST_QUALITY_CHECKERS 注册表
  assert.ok(DEFAULT_TEST_QUALITY_CHECKERS instanceof Map);
  assert.equal(DEFAULT_TEST_QUALITY_CHECKERS.size, 3, "DEFAULT_TEST_QUALITY_CHECKERS 应含 3 个 Checker");
  assert.ok(DEFAULT_TEST_QUALITY_CHECKERS.has("assertion-density"));
  assert.ok(DEFAULT_TEST_QUALITY_CHECKERS.has("test-naming"));
  assert.ok(DEFAULT_TEST_QUALITY_CHECKERS.has("coverage-gap"));

  // 验证工具函数
  const ids = getRegisteredCheckerIds();
  assert.ok(Array.isArray(ids));
  assert.equal(ids.length, 3);

  const checker = getCheckerById("assertion-density");
  assert.ok(checker, "应能获取 assertion-density Checker");

  const nullChecker = getCheckerById("non-existent");
  // 注：getCheckerById 实现 Map.get，不存在时返回 undefined（非 null）
  assert.equal(nullChecker, undefined, "不存在时应返回 undefined");

  // 验证 runAllCheckers 函数
  assert.equal(typeof runAllCheckers, "function", "runAllCheckers 应为函数");
});

// ============================================================================
// T3. Barrel 跨模块集成测试（端到端导入链路）
// ============================================================================

test("T3a: 从 barrel 导入 TestingOrchestrator + CoverageGate + InMemoryLLMClient（来自 coding 模块）端到端可运行", async () => {
  const projectRoot = createTmpProjectDir();
  try {
    setupProjectStructure(projectRoot);

    // 通过 barrel 导入所有必需组件
    const pkcAccessor = new InMemoryPkcAccessor(
      [
        {
          flowId: "flow-barrel-test",
          flowName: "Barrel测试流程",
          steps: [
            {
              order: 1,
              actor: "user",
              action: "提交请求",
              input: {},
              expectedOutput: {},
              stateTransition: "draft→pending",
            },
            {
              order: 2,
              actor: "system",
              action: "处理",
              input: {},
              expectedOutput: {},
              stateTransition: "pending→done",
            },
          ],
          userStory: "Given / When / Then",
          requirementId: "F-001",
          confidence: "documented",
        },
      ],
      []
    );
    const coverageGate = new CoverageGate(pkcAccessor);
    const orchestrator = new TestingOrchestrator({
      coverageGate,
      // 注入 logger 以验证日志回调链路
      logger: (_msg: string, _level?: "info" | "warn" | "error") => {
        // 静默日志（不进行任何操作，仅验证 logger 注入链路）
      },
    });

    const llmClient = new InMemoryLLMClient(unifiedRealResponseGenerator);
    const loopGuard = new LoopGuard({ maxIterations: 5, maxTokens: 100_000 });

    const request: TestingLoopRequest = {
      projectRoot,
      specContent: "# Spec\nF-001 用户下单",
      planContent: "# Plan\nOrderModule",
      tasksContent: "# Tasks\nT-001 OrderAggregate",
      implementationRoot: "src/",
      taskDag: {
        nodes: [
          {
            id: "T-001",
            title: "OrderAggregate",
            requirementId: "F-001",
            dependencies: [],
            fileCluster: "OrderAggregate",
            acceptanceCommand: "npm test",
          },
        ],
        topologicalOrder: ["T-001"],
      },
      acceptanceCriteria: [
        {
          requirementId: "F-001",
          description: "Given / When / Then",
          moduleName: "OrderModule",
        },
      ],
      llmClient,
      pkcAccessor,
      loopGuard,
      coverageThreshold: DEFAULT_COVERAGE_THRESHOLD,
      maxIterations: 5,
      runId: "barrel-test-001",
    };

    const result = await orchestrator.run(request);

    // 验证端到端运行产出物
    assert.ok(result, "应返回 TestingLoopResult");
    assert.equal(result.runId, "barrel-test-001");
    assert.ok(result.events.length > 0, "应有事件流产出");
    assert.ok(result.contractTests.length > 0, "应生成契约测试文件");
    assert.ok(result.e2eTests.length > 0, "应生成 E2E 测试文件");
  } finally {
    cleanupTmpDir(projectRoot);
  }
});

test("T3b: 从 barrel 导入 3 个 staticCheckers + DEFAULT_TEST_QUALITY_CHECKERS 注册表可访问", () => {
  // 验证 3 个 Checker 类可实例化
  const assertionChecker = new AssertionDensityChecker();
  const namingChecker = new TestNamingChecker();
  const coverageGapChecker = new CoverageGapChecker();

  assert.equal(assertionChecker.checkerId, "assertion-density");
  assert.equal(namingChecker.checkerId, "test-naming");
  assert.equal(coverageGapChecker.checkerId, "coverage-gap");

  // 验证注册表
  assert.equal(DEFAULT_TEST_QUALITY_CHECKERS.size, 3);
  // 注：DEFAULT_TEST_QUALITY_CHECKERS 内部持的是单例实例，与本测试 new 出的实例不是同一引用，
  // 因此不能用 strictEqual 比较引用相等性。改为 instanceof + checkerId 双重校验。
  const registeredAssertionChecker = DEFAULT_TEST_QUALITY_CHECKERS.get("assertion-density");
  assert.ok(
    registeredAssertionChecker instanceof AssertionDensityChecker,
    "注册表中的 assertion-density 应为 AssertionDensityChecker 实例"
  );
  assert.equal(registeredAssertionChecker?.checkerId, "assertion-density", "注册表中的 checker 应含正确的 checkerId");

  // 验证 getRegisteredCheckerIds 返回全部 ID
  const ids = getRegisteredCheckerIds();
  assert.deepEqual(
    [...ids].sort(),
    ["assertion-density", "coverage-gap", "test-naming"].sort(),
    "getRegisteredCheckerIds 应返回全部 3 个 Checker ID"
  );

  // 验证 getCheckerById
  for (const id of ids) {
    const checker = getCheckerById(id);
    assert.ok(checker, `getCheckerById(${id}) 应返回非空 Checker`);
  }

  // 验证 runAllCheckers 可调用
  const results = runAllCheckers([], {
    highRiskSymbols: [],
    projectRoot: "/tmp/test",
  });
  assert.ok(Array.isArray(results));
  assert.equal(results.length, 3, "runAllCheckers 应返回 3 个结果");
});

test("T3c: 从 barrel 导入常量（DEFAULT_COVERAGE_THRESHOLD / DEFAULT_MAX_TESTING_ITERATIONS）值正确", () => {
  // 验证常量值与 types.ts 中定义一致
  assert.equal(DEFAULT_COVERAGE_THRESHOLD.lines, 80);
  assert.equal(DEFAULT_COVERAGE_THRESHOLD.branches, 70);
  assert.equal(DEFAULT_COVERAGE_THRESHOLD.functions, 85);
  assert.equal(DEFAULT_COVERAGE_THRESHOLD.highRiskSymbols, 100);

  assert.equal(DEFAULT_MAX_TESTING_ITERATIONS, 5);
  assert.equal(DEFAULT_MAX_TOKENS_PER_TEST_FILE, 4000);
  assert.equal(DEFAULT_MAX_TOKENS_PER_TEST_LLM_CALL, 8000);
  assert.equal(DEFAULT_TEST_GENERATION_TEMPERATURE, 0.2);
  assert.equal(DEFAULT_HIGH_RISK_TOP_N, 10);
  assert.equal(COVERAGE_CONSECUTIVE_FAILURE_THRESHOLD, 2);
  assert.equal(HIGH_RISK_SCORE_THRESHOLD, 0.7);

  // 验证常量冻结
  assert.ok(Object.isFrozen(DEFAULT_COVERAGE_THRESHOLD));
  assert.ok(Object.isFrozen(TESTING_DEFAULTS));

  // 验证 TESTING_DEFAULTS 汇总对象字段一致性
  assert.equal(TESTING_DEFAULTS.maxTestingIterations, DEFAULT_MAX_TESTING_ITERATIONS);
  assert.equal(TESTING_DEFAULTS.maxTokensPerTestFile, DEFAULT_MAX_TOKENS_PER_TEST_FILE);
  assert.equal(TESTING_DEFAULTS.maxTokensPerTestLlmCall, DEFAULT_MAX_TOKENS_PER_TEST_LLM_CALL);
  assert.equal(TESTING_DEFAULTS.testGenerationTemperature, DEFAULT_TEST_GENERATION_TEMPERATURE);
  assert.equal(TESTING_DEFAULTS.contractTestOutputDir, DEFAULT_CONTRACT_TEST_OUTPUT_DIR);
  assert.equal(TESTING_DEFAULTS.e2eTestOutputDir, DEFAULT_E2E_TEST_OUTPUT_DIR);
  assert.equal(TESTING_DEFAULTS.integrationTestOutputDir, DEFAULT_INTEGRATION_TEST_OUTPUT_DIR);
  assert.equal(TESTING_DEFAULTS.highRiskTopN, DEFAULT_HIGH_RISK_TOP_N);
  assert.equal(TESTING_DEFAULTS.coverageConsecutiveFailureThreshold, COVERAGE_CONSECUTIVE_FAILURE_THRESHOLD);
  assert.equal(TESTING_DEFAULTS.highRiskScoreThreshold, HIGH_RISK_SCORE_THRESHOLD);
  assert.equal(TESTING_DEFAULTS.minAssertionsPerTestCase, MIN_ASSERTIONS_PER_TEST_CASE);
});

// ============================================================================
// T4. 完整端到端集成测试
// ============================================================================

/**
 * 完整端到端集成测试：从 barrel 导入所有组件，组装真实 TESTING Loop 并运行。
 *
 * 验证目标：
 * 1. barrel 导出的全部类、接口、常量、工厂函数可协同工作
 * 2. 真实 InMemoryLLMClient + InMemoryPkcAccessor + LoopGuard 端到端运行不报错
 * 3. 编排器产出的 TestingLoopResult 含全部预期字段
 *
 * 注意：c8 不可用环境下，最终状态为 human_checkpoint（覆盖率门禁执行失败）。
 * 这不影响 barrel 导出链路的正确性验证。
 */
test("T4a: 真实 InMemoryLLMClient + InMemoryPkcAccessor + LoopGuard + TestingOrchestrator 端到端运行", async () => {
  const projectRoot = createTmpProjectDir();
  try {
    setupProjectStructure(projectRoot);

    // 通过 barrel 导入全部组件，组装真实 TESTING Loop
    const pkcAccessor = new InMemoryPkcAccessor(
      [
        {
          flowId: "flow-e2e-barrel",
          flowName: "BarrelE2E",
          steps: [
            {
              order: 1,
              actor: "user",
              action: "提交",
              input: {},
              expectedOutput: {},
              stateTransition: "draft→pending",
            },
            {
              order: 2,
              actor: "system",
              action: "处理",
              input: {},
              expectedOutput: {},
              stateTransition: "pending→done",
            },
          ],
          userStory: "Given / When / Then",
          requirementId: "F-001",
          confidence: "documented",
        },
      ],
      []
    );
    const coverageGate = new CoverageGate(pkcAccessor);

    // 通过 barrel 导入 TestingOrchestrator
    const orchestrator = createDefaultTestingOrchestrator(coverageGate);

    // 通过 barrel 导入常量与类型
    const loopGuard = new LoopGuard({
      maxIterations: DEFAULT_MAX_TESTING_ITERATIONS,
      maxTokens: 100_000,
    });
    const llmClient = new InMemoryLLMClient(unifiedRealResponseGenerator);

    // 通过 barrel 导入 createTestingLoopRequest 工厂函数构造请求
    const request = createTestingLoopRequest({
      projectRoot,
      specContent: "# Spec\nF-001 用户下单",
      planContent: "# Plan\nOrderModule",
      tasksContent: "# Tasks\nT-001 OrderAggregate\nT-002 PaymentService",
      implementationRoot: "src/",
      taskDag: {
        nodes: [
          {
            id: "T-001",
            title: "OrderAggregate",
            requirementId: "F-001",
            dependencies: [],
            fileCluster: "OrderAggregate",
            acceptanceCommand: "npm test",
          },
          {
            id: "T-002",
            title: "PaymentService",
            requirementId: "F-001",
            dependencies: ["T-001"],
            fileCluster: "PaymentService",
            acceptanceCommand: "npm test",
          },
        ],
        topologicalOrder: ["T-001", "T-002"],
      },
      acceptanceCriteria: [
        {
          requirementId: "F-001",
          description: "Given 用户已登录 / When 提交订单 / Then 创建订单成功",
          moduleName: "OrderModule",
        },
      ],
      llmClient,
      pkcAccessor,
      loopGuard,
      coverageThreshold: DEFAULT_COVERAGE_THRESHOLD,
      maxIterations: DEFAULT_MAX_TESTING_ITERATIONS,
      runId: "barrel-e2e-001",
    });

    // 执行 TESTING Loop
    const result = await orchestrator.run(request);

    // 验证 TestingLoopResult 全部字段
    assert.ok(result, "应返回 TestingLoopResult");
    assert.equal(result.runId, "barrel-e2e-001", "runId 应与请求一致");
    assert.ok(["success", "human_checkpoint", "stop_failure"].includes(result.finalStatus), "finalStatus 应为合法值");
    assert.ok(Array.isArray(result.contractTests), "contractTests 应为数组");
    assert.ok(Array.isArray(result.e2eTests), "e2eTests 应为数组");
    assert.ok(Array.isArray(result.integrationTests), "integrationTests 应为数组");
    assert.ok(Array.isArray(result.complianceTests), "complianceTests 应为数组");
    assert.ok(typeof result.coverageReport === "object", "coverageReport 应为对象");
    assert.equal(typeof result.prDescription, "string", "prDescription 应为字符串");
    assert.equal(typeof result.totalLlmCallCount, "number", "totalLlmCallCount 应为数字");
    assert.equal(typeof result.totalTokensUsed, "number", "totalTokensUsed 应为数字");
    assert.equal(typeof result.durationSec, "number", "durationSec 应为数字");
    assert.ok(Array.isArray(result.events), "events 应为数组");

    // 验证产出物完整性
    assert.ok(result.contractTests.length > 0, "应生成契约测试文件（taskDag 含 2 个任务）");
    assert.ok(result.e2eTests.length > 0, "应生成 E2E 测试文件");

    // 验证契约测试文件类型
    for (const test of result.contractTests) {
      assert.equal(test.kind, "contract", "契约测试文件 kind 应为 contract");
      assert.ok(test.relativePath, "应含 relativePath");
      assert.ok(test.content, "应含 content");
      assert.ok(test.requirementId, "应含 requirementId");
    }

    // 验证 E2E 测试文件类型
    for (const test of result.e2eTests) {
      assert.equal(test.kind, "e2e", "E2E 测试文件 kind 应为 e2e");
      assert.ok(test.relativePath, "应含 relativePath");
      assert.ok(test.content, "应含 content");
      assert.ok(test.requirementId, "应含 requirementId");
    }

    // 验证事件流含 G-6 通过事件
    const g6Event = result.events.find(
      (e) => e.eventType === "verification_passed" && (e.payload as Record<string, unknown>).gateId === "G-6"
    );
    assert.ok(g6Event, "事件流应含 G-6 通过事件");

    // 验证事件流含契约测试生成完成事件
    const contractGenEvent = result.events.find(
      (e) =>
        e.eventType === "discovery_completed" &&
        (e.payload as Record<string, unknown>).stage === "contract-test-generation"
    );
    assert.ok(contractGenEvent, "事件流应含契约测试生成完成事件");

    // 验证事件流含 E2E 测试生成完成事件
    const e2eGenEvent = result.events.find(
      (e) =>
        e.eventType === "handoff_dispatched" && (e.payload as Record<string, unknown>).stage === "e2e-test-generation"
    );
    assert.ok(e2eGenEvent, "事件流应含 E2E 测试生成完成事件");

    // 验证结果对象冻结
    assert.ok(Object.isFrozen(result), "TestingLoopResult 应冻结");
    assert.ok(Object.isFrozen(result.contractTests), "contractTests 应冻结");
    assert.ok(Object.isFrozen(result.e2eTests), "e2eTests 应冻结");
    assert.ok(Object.isFrozen(result.events), "events 应冻结");
  } finally {
    cleanupTmpDir(projectRoot);
  }
});
