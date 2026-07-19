/**
 * TESTING Loop 子模块群 Barrel 导出（EAG-P3 批次 10）
 *
 * 本模块对齐设计文档 §2 目录树 `eag/testing/index.ts`，统一对外导出 TESTING Loop
 * 全部公共 API，便于 session.ts / gate/ / long-horizon/ 等外部模块从单一入口导入。
 *
 * 导出范围：
 * 1. 数据模型（types.ts）
 * 2. 契约测试生成器（contract-test-generator.ts）
 * 3. E2E 测试生成器（e2e-test-generator.ts）
 * 4. 覆盖率门禁（coverage-gate.ts）
 * 5. 既有契约保护判定器（brownfield-contract-guard.ts）
 * 6. TESTING Loop 编排器（testing-orchestrator.ts）
 * 7. 测试质量静态判定器（static-checkers/）
 *
 * 不可变优先原则（对齐 §5.12.4 G-A6d）：
 * - 所有导出常量使用 Object.freeze 冻结
 * - 所有导出接口字段使用 readonly 修饰
 * - 不导出可变状态（仅导出类、接口、工厂函数、常量）
 *
 * @module eag/testing
 */

// ============================================================================
// 1. 数据模型导出（types.ts）
// ============================================================================

export type {
  // 测试文件类型与生成产出
  TestFileKind,
  GeneratedTestFile,
  ContractTestSpec,
  // E2E 测试规范
  E2eFlowConfidence,
  E2eFlowActor,
  E2eTestSpec,
  E2eFlowStep,
  // 覆盖率门禁
  CoverageThreshold,
  UncoveredSymbol,
  CoverageFailedDimension,
  CoverageReport,
  // 验收标准
  AcceptanceCriterion,
  // PKC 访问器协议
  PkcAccessor,
  // TESTING Loop 编排请求与产出
  TestingLoopFinalStatus,
  TestingLoopRequest,
  TestingLoopResult,
  // 既有契约保护
  BrownfieldContractGuardRequest,
  BreakingChangeKind,
  BreakingChange,
  CompatibleChange,
  ContractCompatibilityReport,
  // 测试质量静态判定器
  TestQualityChecker,
  TestQualitySeverity,
  TestQualityContext,
  TestQualityResult,
  TestQualityViolation,
  // 日志回调
  LogCallback,
  // Loop 事件复用导出
  LoopEvent,
} from "./types";

export {
  // 测试文件类型常量
  TEST_FILE_KINDS,
  // E2E 流程置信度常量
  E2E_FLOW_CONFIDENCES,
  // 覆盖率门禁常量
  DEFAULT_COVERAGE_THRESHOLD,
  COVERAGE_FAILED_DIMENSIONS,
  // breaking change 类型常量
  BREAKING_CHANGE_KINDS,
  // TESTING Loop 最终状态常量
  TESTING_LOOP_FINAL_STATUSES,
  // 测试质量严重级常量
  TEST_QUALITY_SEVERITIES,
  // 默认配置常量
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
  createTestingLoopRequest,
  createContractTestSpec,
  createE2eTestSpec,
  createGeneratedTestFile,
} from "./types";

// ============================================================================
// 2. 契约测试生成器导出（contract-test-generator.ts）
// ============================================================================

export {
  ContractTestGenerator,
  ContractTestGeneratorError,
  OpenApiParseError,
  OpenApiSpecParser,
  TsSignatureExtractor,
  createDefaultContractTestGenerator,
  createOpenApiSpecParser,
  createTsSignatureExtractor,
  DEFAULT_CONTRACT_TEST_TEMPLATES,
} from "./contract-test-generator";

export type { ContractTestGenerationRequest } from "./contract-test-generator";

// ============================================================================
// 3. E2E 测试生成器导出（e2e-test-generator.ts）
// ============================================================================

export { E2eTestGenerator, E2eTestGeneratorError, createDefaultE2eTestGenerator } from "./e2e-test-generator";

export type { E2eTestGenerationRequest, E2eTestGenerationResult } from "./e2e-test-generator";

// ============================================================================
// 4. 覆盖率门禁导出（coverage-gate.ts）
// ============================================================================

export {
  CoverageGate,
  CoverageGateError,
  C8ReportParser,
  createDefaultCoverageGate,
  createC8ReportParser,
  isC8Available,
} from "./coverage-gate";

export type { CoverageGateRequest, C8ParsedReport } from "./coverage-gate";

// ============================================================================
// 5. 既有契约保护判定器导出（brownfield-contract-guard.ts）
// ============================================================================

export {
  BrownfieldContractGuard,
  BrownfieldContractGuardError,
  createDefaultBrownfieldContractGuard,
  DEFAULT_EXISTING_CONTRACTS_RELATIVE_PATH,
} from "./brownfield-contract-guard";

export type { BrownfieldContractGuardErrorKind } from "./brownfield-contract-guard";

// ============================================================================
// 6. TESTING Loop 编排器导出（testing-orchestrator.ts）
// ============================================================================

export {
  TestingOrchestrator,
  TestingOrchestratorError,
  createDefaultTestingOrchestrator,
} from "./testing-orchestrator";

export type {
  TestingOrchestratorErrorKind,
  GateG6Result,
  GateG7Result,
  GateG6Context,
  GateG7Context,
} from "./testing-orchestrator";

// ============================================================================
// 7. 测试质量静态判定器导出（static-checkers/）
// ============================================================================

export {
  // 3 个 Checker 类
  AssertionDensityChecker,
  TestNamingChecker,
  CoverageGapChecker,
  // 注册表与工具函数
  DEFAULT_TEST_QUALITY_CHECKERS,
  getRegisteredCheckerIds,
  getCheckerById,
  runAllCheckers,
} from "./static-checkers";
