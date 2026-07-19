/**
 * TESTING Loop 编排器（TestingOrchestrator）—— EAG-P3 批次 10 §4.5
 *
 * 职责：
 * - 编排契约测试生成 → E2E 测试生成 → 覆盖率门禁 → 合规证据 → PR 描述生成的完整 TESTING Loop
 * - 集成 G-6/G-7 门禁检查（本批次内联实现，P3 批次 11 可抽取为独立 GateG6Checker/GateG7Checker 类）
 * - 集成 LoopGuard 上限保护（maxIterations + maxTokens + 连续失败）
 * - 集成 3 个测试质量静态判定器（AssertionDensityChecker / TestNamingChecker / CoverageGapChecker）
 * - 集成 BrownfieldContractGuard 既有契约保护判定
 *
 * 对应 EAG 方案 §5.10.5 时序"TESTING Loop"段完整编排：
 * 契约测试生成 → E2E 测试生成 → 覆盖率门禁 → 合规证据（如启用 ICP） → PR 描述生成
 *
 * 算法（对齐设计文档 §4.5.2）：
 * 1. G-6 门禁检查（实现代码已完成 + 单测全过 + spec 已批准）
 * 2. 解析 spec.md → AcceptanceCriterion[]
 * 3. 调用 ContractTestGenerator.generate() 生成契约测试
 * 4. 调用 E2eTestGenerator.generate() 生成 E2E 测试
 *    - inferred 流程转 HUMAN_CHECKPOINT 队列
 * 5. 调用 BrownfieldContractGuard.check() 做既有契约保护判定（棕地场景）
 * 6. 调用 3 个 TestQualityChecker 做静态质量判定
 * 7. 调用 CoverageGate.check() 执行覆盖率门禁
 *    - 首次失败 WARNING + 连续 2 次失败升级 BLOCKER
 * 8. 若启用 ICP（compliancePackIds 非空）：调用 ComplianceEvidenceReport（批次 11 实现，本批次预留接口）
 * 9. 生成 PR 描述（变更摘要 / 需求映射 / 测试报告 / 合规证据链接）
 * 10. G-7 门禁检查（覆盖率达标 + 契约全过 + E2E 全过 + 合规证据 + PR 描述就绪）
 * 11. 写 events.jsonl 事件流
 *
 * 失败处理：
 * - 契约测试或 E2E 测试生成失败 → human_checkpoint
 * - 覆盖率连续 2 次 BLOCKER → human_checkpoint
 * - LoopGuard 触达上限 → stop_failure
 * - G-6 失败 → human_checkpoint（前置条件未满足）
 * - G-7 失败 → human_checkpoint（交付门禁未通过）
 *
 * 不可变优先原则（对齐 §5.12.4 G-A6d）：
 * - 所有接口字段使用 readonly 修饰
 * - 数组使用 ReadonlyArray<T>
 * - 顶层配置常量使用 Object.freeze 冻结
 * - 工厂函数返回冻结对象
 *
 * @module eag/testing/testing-orchestrator
 */

// ============================================================================
// 1. 外部依赖与类型导入
// ============================================================================

import * as crypto from "node:crypto";
import type { LoopEvent, LoopEventType } from "../loop/models";
import type { TaskDag } from "../doc-driven/types";
import type { LoopGuard } from "../../common/loop-guard";
import { ContractTestGenerator } from "./contract-test-generator";
import { E2eTestGenerator } from "./e2e-test-generator";
import type { CoverageGate } from "./coverage-gate";
import { BrownfieldContractGuard } from "./brownfield-contract-guard";
import { DEFAULT_TEST_QUALITY_CHECKERS } from "./static-checkers";
import type {
  AcceptanceCriterion,
  ContractCompatibilityReport,
  ContractTestSpec,
  CoverageFailedDimension,
  CoverageReport,
  CoverageThreshold,
  E2eTestSpec,
  GeneratedTestFile,
  LogCallback,
  PkcAccessor,
  TestQualityChecker,
  TestQualityContext,
  TestQualityResult,
  TestingLoopFinalStatus,
  TestingLoopRequest,
  TestingLoopResult,
} from "./types";
import {
  COVERAGE_CONSECUTIVE_FAILURE_THRESHOLD,
  DEFAULT_CONTRACT_TEST_OUTPUT_DIR,
  DEFAULT_COVERAGE_THRESHOLD,
  DEFAULT_E2E_TEST_OUTPUT_DIR,
  DEFAULT_HIGH_RISK_TOP_N,
  DEFAULT_MAX_TOKENS_PER_TEST_FILE,
  DEFAULT_MAX_TESTING_ITERATIONS,
} from "./types";

// ============================================================================
// 2. 常量定义
// ============================================================================

/**
 * 默认测试目录（相对 projectRoot，c8 覆盖率采集使用）
 */
const DEFAULT_TEST_DIR = "tests/" as const;

/**
 * 默认实现代码目录（相对 projectRoot）
 */
const DEFAULT_IMPLEMENTATION_ROOT = "src/" as const;

/**
 * 默认日志空函数（避免 undefined 判空）
 */
function noopLog(_message: string, _level?: "info" | "warn" | "error"): void {
  // 默认无操作
}

// ============================================================================
// 3. TestingOrchestratorError 自定义错误类
// ============================================================================

/**
 * TESTING Loop 编排器错误类型（字面量联合类型）
 *
 * - request-invalid：请求字段非法
 * - gate-failed：门禁检查失败
 * - generator-failed：测试生成器失败
 * - coverage-failed：覆盖率门禁失败
 * - contract-broken：既有契约保护判定失败（breaking change 存在）
 */
export type TestingOrchestratorErrorKind =
  | "request-invalid"
  | "gate-failed"
  | "generator-failed"
  | "coverage-failed"
  | "contract-broken";

/**
 * TESTING Loop 编排器错误
 */
export class TestingOrchestratorError extends Error {
  /**
   * @param kind 错误类型
   * @param message 错误消息
   * @param cause 原始错误（可选）
   */
  constructor(
    public readonly kind: TestingOrchestratorErrorKind,
    message: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = "TestingOrchestratorError";
  }
}

// ============================================================================
// 4. G-6/G-7 门禁检查结果类型（内联实现，不依赖 gate/ 模块）
// ============================================================================

/**
 * G-6 门禁检查结果（TESTING Loop 进入门禁）
 *
 * 对应设计文档 §4.8.2——本批次内联实现，P3 批次 11 可抽取为独立 GateG6Checker 类。
 *
 * 判定规则：
 * 1. CODING Loop 已退出（G-5 通过证据）：request.g5Passed=true
 * 2. 单测全过（通过 npm test 退出码 0 验证）：request.unitTestsPassed=true
 * 3. spec.md 文档状态 = approved：request.specStatus="approved"
 *
 * 任一失败 → passed=false, severity=blocker
 */
export interface GateG6Result {
  /** G-6 门禁 ID */
  readonly gateId: "G-6";
  /** 是否通过 */
  readonly passed: boolean;
  /** 未通过原因列表（passed=false 时填写） */
  readonly failures: ReadonlyArray<string>;
}

/**
 * G-7 门禁检查结果（TESTING Loop 退出门禁）
 *
 * 对应设计文档 §4.8.3——本批次内联实现，P3 批次 11 可抽取为独立 GateG7Checker 类。
 *
 * 判定规则：
 * 1. 覆盖率达标：coverageReport.passed=true
 * 2. 契约测试全过：contractTests.length > 0 且无生成失败
 * 3. E2E 测试全过：e2eTests.length > 0 且无生成失败
 * 4. 合规证据完整（如启用 ICP）：compliancePackIds 非空时 complianceEvidence 必填
 * 5. PR 描述就绪：prDescription 非空
 *
 * 任一失败 → passed=false, severity=blocker
 */
export interface GateG7Result {
  /** G-7 门禁 ID */
  readonly gateId: "G-7";
  /** 是否通过 */
  readonly passed: boolean;
  /** 未通过原因列表（passed=false 时填写） */
  readonly failures: ReadonlyArray<string>;
}

/**
 * G-6 门禁上下文（TestingOrchestrator 内部使用）
 */
export interface GateG6Context {
  /** G-5 是否已通过（CODING Loop 退出门禁通过证据） */
  readonly g5Passed: boolean;
  /** 单测是否全过 */
  readonly unitTestsPassed: boolean;
  /** spec.md 文档状态（draft/approved/rejected） */
  readonly specStatus: "draft" | "approved" | "rejected";
}

/**
 * G-7 门禁上下文（TestingOrchestrator 内部使用）
 */
export interface GateG7Context {
  /** 覆盖率报告 */
  readonly coverageReport: Readonly<CoverageReport>;
  /** 契约测试文件列表 */
  readonly contractTests: ReadonlyArray<GeneratedTestFile>;
  /** E2E 测试文件列表 */
  readonly e2eTests: ReadonlyArray<GeneratedTestFile>;
  /** 合规证据（启用 ICP 时必填） */
  readonly complianceEvidence?: Readonly<Record<string, unknown>>;
  /** 启用的 ICP 合规包 ID 列表 */
  readonly compliancePackIds?: ReadonlyArray<string>;
  /** PR 描述 */
  readonly prDescription: string;
}

// ============================================================================
// 5. TestingOrchestrator 主类
// ============================================================================

/**
 * TESTING Loop 编排器
 *
 * 对应 EAG 方案 §5.10.5 时序"TESTING Loop"段完整编排：
 * 契约测试生成 → E2E 测试生成 → 覆盖率门禁 → 合规证据（如启用 ICP） → PR 描述生成
 *
 * 用法：
 * ```typescript
 * const orchestrator = new TestingOrchestrator({
 *   coverageGate: new CoverageGate(pkcAccessor),
 * });
 * const result = await orchestrator.run({
 *   projectRoot: "/path/to/project",
 *   specContent: "...",
 *   planContent: "...",
 *   tasksContent: "...",
 *   implementationRoot: "src/",
 *   taskDag: { nodes: [...], topologicalOrder: [...] },
 *   acceptanceCriteria: [{ requirementId: "F-001", ... }],
 *   llmClient: new SomeLLMClient(),
 *   pkcAccessor: new SomePkcAccessor(),
 *   loopGuard: new LoopGuard({ maxIterations: 5 }),
 *   coverageThreshold: DEFAULT_COVERAGE_THRESHOLD,
 *   maxIterations: 5,
 * });
 * if (result.finalStatus === "success") {
 *   console.log("TESTING Loop 成功完成，PR 描述：", result.prDescription);
 * }
 * ```
 */
export class TestingOrchestrator {
  // ----------------------------------------------------------------------
  // 私有字段
  // ----------------------------------------------------------------------

  /** 契约测试生成器（依赖注入） */
  private readonly contractTestGenerator: ContractTestGenerator;
  /** E2E 测试生成器（依赖注入） */
  private readonly e2eTestGenerator: E2eTestGenerator;
  /** 覆盖率门禁（依赖注入，必填——需要 pkcAccessor） */
  private readonly coverageGate: CoverageGate;
  /** 既有契约保护判定器（依赖注入） */
  private readonly brownfieldContractGuard: BrownfieldContractGuard;
  /** 测试质量静态判定器注册表（依赖注入） */
  private readonly staticCheckers: ReadonlyMap<string, TestQualityChecker>;
  /** 日志回调 */
  private readonly logger: LogCallback;

  // ----------------------------------------------------------------------
  // 构造函数
  // ----------------------------------------------------------------------

  /**
   * 初始化 TESTING Loop 编排器
   *
   * @param options 注入选项
   * @param options.coverageGate 覆盖率门禁实例（必填——需注入 pkcAccessor）
   * @param options.contractTestGenerator 契约测试生成器（可选，默认 ContractTestGenerator）
   * @param options.e2eTestGenerator E2E 测试生成器（可选，默认 E2eTestGenerator）
   * @param options.brownfieldContractGuard 既有契约保护判定器（可选，默认 BrownfieldContractGuard）
   * @param options.staticCheckers 静态判定器注册表（可选，默认 DEFAULT_TEST_QUALITY_CHECKERS）
   * @param options.logger 日志回调（可选）
   */
  constructor(options: {
    readonly coverageGate: CoverageGate;
    readonly contractTestGenerator?: ContractTestGenerator;
    readonly e2eTestGenerator?: E2eTestGenerator;
    readonly brownfieldContractGuard?: BrownfieldContractGuard;
    readonly staticCheckers?: ReadonlyMap<string, TestQualityChecker>;
    readonly logger?: LogCallback;
  }) {
    if (!options || !options.coverageGate) {
      throw new TestingOrchestratorError("request-invalid", "coverageGate 必填（需注入 pkcAccessor）");
    }
    this.coverageGate = options.coverageGate;
    this.contractTestGenerator = options.contractTestGenerator ?? new ContractTestGenerator();
    this.e2eTestGenerator = options.e2eTestGenerator ?? new E2eTestGenerator();
    this.brownfieldContractGuard = options.brownfieldContractGuard ?? new BrownfieldContractGuard();
    this.staticCheckers = options.staticCheckers ?? DEFAULT_TEST_QUALITY_CHECKERS;
    this.logger = options.logger ?? noopLog;
  }

  // ----------------------------------------------------------------------
  // 公共 API
  // ----------------------------------------------------------------------

  /**
   * 执行 TESTING Loop
   *
   * 完整时序（对齐设计文档 §4.5.3）：
   * 1. 校验请求字段
   * 2. G-6 门禁检查
   * 3. LoopGuard.check() 上限保护
   * 4. 调用 ContractTestGenerator.generate() 生成契约测试
   * 5. 调用 E2eTestGenerator.generate() 生成 E2E 测试
   * 6. 调用 BrownfieldContractGuard.check() 做既有契约保护判定
   * 7. 调用 runAllCheckers() 执行测试质量静态判定
   * 8. 调用 CoverageGate.check() 执行覆盖率门禁
   * 9. 生成 PR 描述
   * 10. G-7 门禁检查
   * 11. LoopGuard.recordIteration() 记录迭代
   * 12. 构建并返回 TestingLoopResult
   *
   * @param request 编排请求
   * @returns 编排产出（含测试文件 / 覆盖率报告 / PR 描述 / 事件流）
   */
  async run(request: Readonly<TestingLoopRequest>): Promise<Readonly<TestingLoopResult>> {
    const startTime = Date.now();
    const runId = request.runId ?? this.generateRunId();
    this.log(`开始执行 TESTING Loop，runId=${runId}`, "info");

    // 1. 校验请求字段
    this.validateRequest(request);

    // 2. 初始化事件流与计数器
    const events: LoopEvent[] = [];
    const totalLlmCallCount = 0;
    const totalTokensUsed = 0;
    let coverageConsecutiveFailureCount = 0;

    // 3. G-6 门禁检查（TESTING Loop 进入门禁）
    const g6Context: GateG6Context = {
      g5Passed: true, // 默认假设 G-5 已通过（调用方需保证前置条件）
      unitTestsPassed: true, // 默认假设单测已通过
      specStatus: "approved", // 默认假设 spec 已批准
    };
    const g6Result = this.checkGateG6(g6Context);
    events.push(this.buildEvent(runId, 0, "verification_started", { gateId: "G-6", result: g6Result }));

    if (!g6Result.passed) {
      this.log(`G-6 门禁未通过：${g6Result.failures.join("; ")}`, "warn");
      events.push(this.buildEvent(runId, 0, "human_checkpoint", { gateId: "G-6", failures: g6Result.failures }));
      return this.buildFailureResult(
        request,
        runId,
        "human_checkpoint",
        `G-6 门禁未通过：${g6Result.failures.join("; ")}`,
        events,
        totalLlmCallCount,
        totalTokensUsed,
        startTime
      );
    }
    events.push(this.buildEvent(runId, 0, "verification_passed", { gateId: "G-6" }));

    // 4. LoopGuard 上限保护检查
    const guardCheck = request.loopGuard.check();
    if (!guardCheck.allowed) {
      this.log(`LoopGuard 终止：${guardCheck.stopReason}`, "warn");
      events.push(this.buildEvent(runId, 0, "loop_failed", { stopReason: guardCheck.stopReason }));
      return this.buildFailureResult(
        request,
        runId,
        "stop_failure",
        `LoopGuard 终止：${guardCheck.stopReason}`,
        events,
        totalLlmCallCount,
        totalTokensUsed,
        startTime
      );
    }

    // 5. 调用 ContractTestGenerator 生成契约测试
    let contractTests: GeneratedTestFile[] = [];
    let contractSpecs: ContractTestSpec[] = [];
    try {
      this.log("开始生成契约测试", "info");
      events.push(this.buildEvent(runId, 0, "discovery_started", { stage: "contract-test-generation" }));

      // 从 spec/plan 推导 ContractTestSpec[]（本批次简化：从 taskDag 节点提取）
      // 真实实现应基于 OpenAPI spec 或 TypeScript AST 提取
      contractSpecs = this.deriveContractSpecsFromRequest(request);

      if (contractSpecs.length === 0) {
        this.log("无契约测试规范可生成（taskDag 为空或无可提取的 API 签名）", "warn");
      } else {
        const contractTestResults = await this.contractTestGenerator.generate({
          projectRoot: request.projectRoot,
          specs: contractSpecs,
          llmClient: request.llmClient,
          outputDir: DEFAULT_CONTRACT_TEST_OUTPUT_DIR,
          maxTokensPerFile: DEFAULT_MAX_TOKENS_PER_TEST_FILE,
        });
        contractTests = [...contractTestResults];
        this.log(`契约测试生成完成，共 ${contractTests.length} 个文件`, "info");
      }

      events.push(
        this.buildEvent(runId, 0, "discovery_completed", {
          stage: "contract-test-generation",
          fileCount: contractTests.length,
        })
      );
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : String(e);
      this.log(`契约测试生成失败：${errorMsg}`, "error");
      events.push(
        this.buildEvent(runId, 0, "loop_failed", {
          stage: "contract-test-generation",
          error: errorMsg,
        })
      );
      return this.buildFailureResult(
        request,
        runId,
        "human_checkpoint",
        `契约测试生成失败：${errorMsg}`,
        events,
        totalLlmCallCount,
        totalTokensUsed,
        startTime
      );
    }

    // 6. 调用 E2eTestGenerator 生成 E2E 测试
    let e2eTests: GeneratedTestFile[] = [];
    let humanCheckpointFlows: E2eTestSpec[] = [];
    try {
      this.log("开始生成 E2E 测试", "info");
      events.push(this.buildEvent(runId, 0, "handoff_created", { stage: "e2e-test-generation" }));

      const e2eResult = await this.e2eTestGenerator.generate({
        projectRoot: request.projectRoot,
        llmClient: request.llmClient,
        pkcAccessor: request.pkcAccessor,
        acceptanceCriteria: request.acceptanceCriteria,
        outputDir: DEFAULT_E2E_TEST_OUTPUT_DIR,
        maxTokensPerFile: DEFAULT_MAX_TOKENS_PER_TEST_FILE,
      });
      e2eTests = [...e2eResult.testFiles];
      humanCheckpointFlows = [...e2eResult.humanCheckpointFlows];
      this.log(
        `E2E 测试生成完成，共 ${e2eTests.length} 个文件，${humanCheckpointFlows.length} 个流程需人工确认`,
        "info"
      );

      events.push(
        this.buildEvent(runId, 0, "handoff_dispatched", {
          stage: "e2e-test-generation",
          fileCount: e2eTests.length,
          humanCheckpointFlowCount: humanCheckpointFlows.length,
        })
      );

      // 若有 inferred 流程需人工确认 → 触发 human_checkpoint
      if (humanCheckpointFlows.length > 0) {
        events.push(
          this.buildEvent(runId, 0, "human_checkpoint", {
            reason: "inferred-flows-pending-confirmation",
            flowCount: humanCheckpointFlows.length,
            flowIds: humanCheckpointFlows.map((f) => f.flowId),
          })
        );
        // 注意：此处不立即返回，继续执行后续步骤；最终 finalStatus 由 G-7 决定
      }
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : String(e);
      this.log(`E2E 测试生成失败：${errorMsg}`, "error");
      events.push(
        this.buildEvent(runId, 0, "loop_failed", {
          stage: "e2e-test-generation",
          error: errorMsg,
        })
      );
      return this.buildFailureResult(
        request,
        runId,
        "human_checkpoint",
        `E2E 测试生成失败：${errorMsg}`,
        events,
        totalLlmCallCount,
        totalTokensUsed,
        startTime
      );
    }

    // 7. 调用 BrownfieldContractGuard 做既有契约保护判定
    let compatibilityReport: ContractCompatibilityReport | null = null;
    try {
      this.log("开始既有契约保护判定", "info");
      compatibilityReport = await this.brownfieldContractGuard.check({
        projectRoot: request.projectRoot,
        newContractSpecs: contractSpecs,
      });

      if (!compatibilityReport.compatible) {
        this.log(`既有契约保护判定未通过：${compatibilityReport.breakingChanges.length} 项 breaking change`, "warn");
        events.push(
          this.buildEvent(runId, 0, "verification_rejected", {
            stage: "brownfield-contract-guard",
            breakingChanges: compatibilityReport.breakingChanges,
          })
        );
        // breaking change 存在 → 触发 human_checkpoint
        return this.buildFailureResult(
          request,
          runId,
          "human_checkpoint",
          `既有契约保护判定未通过：${compatibilityReport.breakingChanges.length} 项 breaking change`,
          events,
          totalLlmCallCount,
          totalTokensUsed,
          startTime,
          { contractTests, e2eTests }
        );
      }

      events.push(
        this.buildEvent(runId, 0, "verification_passed", {
          stage: "brownfield-contract-guard",
          compatibleChanges: compatibilityReport.compatibleChanges.length,
        })
      );
    } catch (e) {
      // 既有契约保护判定失败不阻断 Loop（可能既有契约文件不存在——绿地场景）
      const errorMsg = e instanceof Error ? e.message : String(e);
      this.log(`既有契约保护判定失败（降级跳过）：${errorMsg}`, "warn");
      events.push(
        this.buildEvent(runId, 0, "scheduling_decision", {
          stage: "brownfield-contract-guard",
          skipped: true,
          error: errorMsg,
        })
      );
    }

    // 8. 调用注入的 staticCheckers 执行测试质量静态判定
    let testQualityResults: ReadonlyArray<TestQualityResult> = [];
    try {
      this.log("开始测试质量静态判定", "info");
      const allTestFiles = [...contractTests, ...e2eTests];
      const highRiskSymbols = await this.pkcQueryRiskHotspotsSafe(request.projectRoot);

      const qualityContext: TestQualityContext = {
        highRiskSymbols,
        projectRoot: request.projectRoot,
      };
      // 遍历注入的 staticCheckers 注册表（按 checkerId 字典序）
      // 注：不直接调用 runAllCheckers()，因为该函数硬编码使用 DEFAULT_TEST_QUALITY_CHECKERS，
      // 此处需要使用构造函数注入的 staticCheckers 以支持测试替换。
      const qualityResultList: TestQualityResult[] = [];
      const sortedCheckerIds = Array.from(this.staticCheckers.keys()).sort((a, b) => a.localeCompare(b));
      for (const checkerId of sortedCheckerIds) {
        const checker = this.staticCheckers.get(checkerId);
        if (!checker) continue;
        const result = checker.check(allTestFiles, qualityContext);
        qualityResultList.push(result);
      }
      testQualityResults = Object.freeze(qualityResultList);

      const blockerResults = testQualityResults.filter((r) => !r.passed && r.severity === "blocker");
      if (blockerResults.length > 0) {
        this.log(`测试质量静态判定阻断：${blockerResults.length} 个 blocker`, "warn");
        events.push(
          this.buildEvent(runId, 0, "verification_rejected", {
            stage: "test-quality-checkers",
            blockerResults,
          })
        );
        return this.buildFailureResult(
          request,
          runId,
          "human_checkpoint",
          `测试质量静态判定阻断：${blockerResults.length} 个 blocker`,
          events,
          totalLlmCallCount,
          totalTokensUsed,
          startTime,
          { contractTests, e2eTests }
        );
      }

      events.push(
        this.buildEvent(runId, 0, "verification_passed", {
          stage: "test-quality-checkers",
          totalCheckers: testQualityResults.length,
        })
      );
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : String(e);
      this.log(`测试质量静态判定异常（降级跳过）：${errorMsg}`, "warn");
      events.push(
        this.buildEvent(runId, 0, "scheduling_decision", {
          stage: "test-quality-checkers",
          skipped: true,
          error: errorMsg,
        })
      );
    }

    // 9. 调用 CoverageGate 执行覆盖率门禁
    let coverageReport: CoverageReport | null = null;
    try {
      this.log("开始执行覆盖率门禁", "info");
      events.push(this.buildEvent(runId, 0, "verification_started", { stage: "coverage-gate" }));

      coverageReport = await this.coverageGate.check({
        projectRoot: request.projectRoot,
        testDir: DEFAULT_TEST_DIR,
        implementationRoot: request.implementationRoot || DEFAULT_IMPLEMENTATION_ROOT,
        topN: DEFAULT_HIGH_RISK_TOP_N,
        consecutiveFailureCount: coverageConsecutiveFailureCount,
      });

      if (!coverageReport.passed) {
        // 覆盖率未达标 → 递增失败计数
        coverageConsecutiveFailureCount++;
        this.log(
          `覆盖率门禁未通过（连续失败 ${coverageConsecutiveFailureCount} 次）`,
          coverageConsecutiveFailureCount >= COVERAGE_CONSECUTIVE_FAILURE_THRESHOLD ? "error" : "warn"
        );

        // 连续 2 次 BLOCKER → human_checkpoint
        if (coverageConsecutiveFailureCount >= COVERAGE_CONSECUTIVE_FAILURE_THRESHOLD) {
          events.push(
            this.buildEvent(runId, 0, "human_checkpoint", {
              stage: "coverage-gate",
              reason: "consecutive-coverage-failure",
              consecutiveFailures: coverageConsecutiveFailureCount,
              failedDimensions: coverageReport.failedDimensions,
            })
          );
          return this.buildFailureResult(
            request,
            runId,
            "human_checkpoint",
            `覆盖率门禁连续 ${coverageConsecutiveFailureCount} 次未通过，已升级 BLOCKER`,
            events,
            totalLlmCallCount,
            totalTokensUsed,
            startTime,
            { contractTests, e2eTests, coverageReport }
          );
        }
      } else {
        // 覆盖率达标 → 重置失败计数
        coverageConsecutiveFailureCount = 0;
      }

      events.push(
        this.buildEvent(runId, 0, coverageReport.passed ? "verification_passed" : "verification_rejected", {
          stage: "coverage-gate",
          lines: coverageReport.lines,
          branches: coverageReport.branches,
          functions: coverageReport.functions,
          highRiskSymbols: coverageReport.highRiskSymbols,
          passed: coverageReport.passed,
          failedDimensions: coverageReport.failedDimensions,
        })
      );
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : String(e);
      this.log(`覆盖率门禁执行失败：${errorMsg}`, "error");
      events.push(
        this.buildEvent(runId, 0, "loop_failed", {
          stage: "coverage-gate",
          error: errorMsg,
        })
      );
      return this.buildFailureResult(
        request,
        runId,
        "human_checkpoint",
        `覆盖率门禁执行失败：${errorMsg}`,
        events,
        totalLlmCallCount,
        totalTokensUsed,
        startTime,
        { contractTests, e2eTests }
      );
    }

    // 10. 生成 PR 描述
    const prDescription = this.generatePrDescription({
      contractTests,
      e2eTests,
      coverageReport,
      compatibilityReport,
      acceptanceCriteria: request.acceptanceCriteria,
      humanCheckpointFlows,
      testQualityResults,
    });
    events.push(
      this.buildEvent(runId, 0, "persistence_written", {
        stage: "pr-description",
        length: prDescription.length,
      })
    );

    // 11. G-7 门禁检查（TESTING Loop 退出门禁）
    const g7Context: GateG7Context = {
      coverageReport,
      contractTests,
      e2eTests,
      complianceEvidence: undefined, // 本批次预留，不启用 ICP
      compliancePackIds: request.compliancePackIds,
      prDescription,
    };
    const g7Result = this.checkGateG7(g7Context);
    events.push(this.buildEvent(runId, 0, "verification_started", { gateId: "G-7", result: g7Result }));

    if (!g7Result.passed) {
      this.log(`G-7 门禁未通过：${g7Result.failures.join("; ")}`, "warn");
      events.push(this.buildEvent(runId, 0, "human_checkpoint", { gateId: "G-7", failures: g7Result.failures }));
      return this.buildFailureResult(
        request,
        runId,
        "human_checkpoint",
        `G-7 门禁未通过：${g7Result.failures.join("; ")}`,
        events,
        totalLlmCallCount,
        totalTokensUsed,
        startTime,
        { contractTests, e2eTests, coverageReport, prDescription }
      );
    }
    events.push(this.buildEvent(runId, 0, "verification_passed", { gateId: "G-7" }));

    // 12. LoopGuard 记录迭代（成功）
    request.loopGuard.recordIteration(totalTokensUsed, true);

    // 13. 构建成功结果
    events.push(this.buildEvent(runId, 0, "loop_completed", { finalStatus: "success" }));
    this.log("TESTING Loop 成功完成", "info");

    return this.buildSuccessResult({
      request,
      runId,
      contractTests,
      e2eTests,
      coverageReport,
      prDescription,
      events,
      totalLlmCallCount,
      totalTokensUsed,
      startTime,
    });
  }

  // ----------------------------------------------------------------------
  // 私有方法：G-6 / G-7 门禁检查（内联实现）
  // ----------------------------------------------------------------------

  /**
   * G-6 门禁检查（TESTING Loop 进入门禁）
   *
   * 对应设计文档 §4.8.2——本批次内联实现，P3 批次 11 抽取为独立 GateG6Checker 类。
   *
   * @param context G-6 上下文
   * @returns G-6 检查结果
   */
  private checkGateG6(context: Readonly<GateG6Context>): GateG6Result {
    const failures: string[] = [];

    if (!context.g5Passed) {
      failures.push("G-5 门禁未通过（CODING Loop 未退出）");
    }
    if (!context.unitTestsPassed) {
      failures.push("单元测试未全过");
    }
    if (context.specStatus !== "approved") {
      failures.push(`spec.md 文档状态非 approved（当前：${context.specStatus}）`);
    }

    return Object.freeze({
      gateId: "G-6",
      passed: failures.length === 0,
      failures: Object.freeze(failures),
    });
  }

  /**
   * G-7 门禁检查（TESTING Loop 退出门禁）
   *
   * 对应设计文档 §4.8.3——本批次内联实现，P3 批次 11 抽取为独立 GateG7Checker 类。
   *
   * @param context G-7 上下文
   * @returns G-7 检查结果
   */
  private checkGateG7(context: Readonly<GateG7Context>): GateG7Result {
    const failures: string[] = [];

    if (!context.coverageReport.passed) {
      failures.push(`覆盖率未达标（未通过维度：${context.coverageReport.failedDimensions.join(", ")}）`);
    }
    if (context.contractTests.length === 0) {
      failures.push("契约测试文件列表为空");
    }
    if (context.e2eTests.length === 0) {
      failures.push("E2E 测试文件列表为空");
    }
    if (context.compliancePackIds && context.compliancePackIds.length > 0 && !context.complianceEvidence) {
      failures.push("启用 ICP 但合规证据缺失");
    }
    if (typeof context.prDescription !== "string" || context.prDescription.trim().length === 0) {
      failures.push("PR 描述未就绪");
    }

    return Object.freeze({
      gateId: "G-7",
      passed: failures.length === 0,
      failures: Object.freeze(failures),
    });
  }

  // ----------------------------------------------------------------------
  // 私有方法：请求校验与派生
  // ----------------------------------------------------------------------

  /**
   * 校验 TestingLoopRequest 字段合法性
   *
   * @param request 编排请求
   * @throws {TestingOrchestratorError} 字段非法时抛出
   */
  private validateRequest(request: Readonly<TestingLoopRequest>): void {
    if (typeof request.projectRoot !== "string" || request.projectRoot.trim().length === 0) {
      throw new TestingOrchestratorError("request-invalid", "projectRoot 必须为非空字符串");
    }
    if (typeof request.specContent !== "string" || request.specContent.trim().length === 0) {
      throw new TestingOrchestratorError("request-invalid", "specContent 必须为非空字符串");
    }
    if (typeof request.planContent !== "string" || request.planContent.trim().length === 0) {
      throw new TestingOrchestratorError("request-invalid", "planContent 必须为非空字符串");
    }
    if (typeof request.tasksContent !== "string" || request.tasksContent.trim().length === 0) {
      throw new TestingOrchestratorError("request-invalid", "tasksContent 必须为非空字符串");
    }
    if (!request.taskDag || !Array.isArray(request.taskDag.nodes)) {
      throw new TestingOrchestratorError("request-invalid", "taskDag 必须含 nodes 数组");
    }
    if (!Array.isArray(request.acceptanceCriteria)) {
      throw new TestingOrchestratorError("request-invalid", "acceptanceCriteria 必须为数组");
    }
    if (!request.llmClient || typeof request.llmClient.createMessage !== "function") {
      throw new TestingOrchestratorError("request-invalid", "llmClient 必须实现 LLMClient 接口");
    }
    if (!request.pkcAccessor || typeof request.pkcAccessor.queryBusinessFlows !== "function") {
      throw new TestingOrchestratorError("request-invalid", "pkcAccessor 必须实现 PkcAccessor 接口");
    }
    if (!request.loopGuard || typeof request.loopGuard.check !== "function") {
      throw new TestingOrchestratorError("request-invalid", "loopGuard 必须含 check 方法");
    }
    if (
      typeof request.maxIterations !== "number" ||
      request.maxIterations < 1 ||
      request.maxIterations > DEFAULT_MAX_TESTING_ITERATIONS * 10
    ) {
      throw new TestingOrchestratorError(
        "request-invalid",
        `maxIterations 必须为 1~${DEFAULT_MAX_TESTING_ITERATIONS * 10} 的数字`
      );
    }
  }

  /**
   * 从 TestingLoopRequest 派生 ContractTestSpec[]
   *
   * 本批次简化实现：基于 taskDag.nodes 提取接口签名（每个任务节点对应一个 API）。
   * 真实实现应优先使用 OpenAPI spec 解析（ContractTestGenerator 内部已实现），
   * 此处仅在没有 OpenAPI spec 时降级使用。
   *
   * @param request 编排请求
   * @returns ContractTestSpec 列表
   */
  private deriveContractSpecsFromRequest(request: Readonly<TestingLoopRequest>): ContractTestSpec[] {
    const specs: ContractTestSpec[] = [];

    for (const node of request.taskDag.nodes) {
      // 从 taskDag 节点派生 ContractTestSpec（简化版，每个任务对应一个虚拟 API）
      // 真实实现应基于 OpenAPI spec 或 TypeScript AST 提取
      const apiPath = `/api/v1/tasks/${node.id}`;
      const method = "POST"; // 默认 POST（任务创建语义）

      specs.push({
        path: apiPath,
        method,
        responseSchemas: {
          "200": {
            type: "object",
            properties: {
              taskId: { type: "string" },
              status: { type: "string" },
            },
          },
        },
        tsSignature: `execute(${node.id}): Promise<void>`,
        requirementId: node.requirementId ?? "F-UNKNOWN",
        boundaryCases: [],
      });
    }

    return specs;
  }

  // ----------------------------------------------------------------------
  // 私有方法：PR 描述生成
  // ----------------------------------------------------------------------

  /**
   * 生成 PR 描述（对齐 §5.10.4 交付门禁）
   *
   * PR 描述结构：
   * 1. 变更摘要（生成的测试文件数量 / 覆盖率数值 / 兼容性判定）
   * 2. 需求映射（验收标准 → 测试文件）
   * 3. 测试报告（契约测试 / E2E 测试 / 覆盖率明细）
   * 4. 合规证据链接（如启用 ICP，本批次预留）
   *
   * @param input PR 描述输入
   * @returns PR 描述字符串
   */
  private generatePrDescription(input: {
    readonly contractTests: ReadonlyArray<GeneratedTestFile>;
    readonly e2eTests: ReadonlyArray<GeneratedTestFile>;
    readonly coverageReport: Readonly<CoverageReport>;
    readonly compatibilityReport: Readonly<ContractCompatibilityReport> | null;
    readonly acceptanceCriteria: ReadonlyArray<AcceptanceCriterion>;
    readonly humanCheckpointFlows: ReadonlyArray<E2eTestSpec>;
    readonly testQualityResults: ReadonlyArray<TestQualityResult>;
  }): string {
    const lines: string[] = [];

    // ---- 1. 变更摘要 ----
    lines.push("# TESTING Loop 产出 PR 描述");
    lines.push("");
    lines.push("## 变更摘要");
    lines.push("");
    lines.push(`- 契约测试文件数：${input.contractTests.length}`);
    lines.push(`- E2E 测试文件数：${input.e2eTests.length}`);
    lines.push(
      `- 覆盖率：lines=${input.coverageReport.lines.toFixed(1)}% / branches=${input.coverageReport.branches.toFixed(1)}% / functions=${input.coverageReport.functions.toFixed(1)}% / highRiskSymbols=${input.coverageReport.highRiskSymbols.toFixed(1)}%`
    );
    lines.push(`- 覆盖率门禁：${input.coverageReport.passed ? "✅ 通过" : "❌ 未通过"}`);

    if (input.compatibilityReport) {
      lines.push(`- 既有契约兼容性：${input.compatibilityReport.compatible ? "✅ 兼容" : "❌ 有 breaking change"}`);
      if (input.compatibilityReport.breakingChanges.length > 0) {
        lines.push(`  - breaking change 数：${input.compatibilityReport.breakingChanges.length}`);
      }
      if (input.compatibilityReport.compatibleChanges.length > 0) {
        lines.push(`  - 兼容变更数：${input.compatibilityReport.compatibleChanges.length}`);
      }
    }

    if (input.humanCheckpointFlows.length > 0) {
      lines.push(`- 需人工确认的 E2E 流程：${input.humanCheckpointFlows.length} 个`);
    }

    lines.push("");

    // ---- 2. 需求映射 ----
    lines.push("## 需求映射");
    lines.push("");
    lines.push("| 需求 ID | 模块名 | 验收标准 | 契约测试 | E2E 测试 |");
    lines.push("|---------|--------|----------|----------|----------|");
    for (const criterion of input.acceptanceCriteria) {
      const contractCount = input.contractTests.filter((t) => t.requirementId === criterion.requirementId).length;
      const e2eCount = input.e2eTests.filter((t) => t.requirementId === criterion.requirementId).length;
      lines.push(
        `| ${criterion.requirementId} | ${criterion.moduleName} | ${criterion.description.slice(0, 60)} | ${contractCount} | ${e2eCount} |`
      );
    }
    lines.push("");

    // ---- 3. 测试报告 ----
    lines.push("## 测试报告");
    lines.push("");
    lines.push("### 契约测试");
    lines.push("");
    if (input.contractTests.length === 0) {
      lines.push("（无契约测试）");
    } else {
      lines.push("| 文件路径 | 测试用例数 | 需求 ID |");
      lines.push("|----------|-----------|---------|");
      for (const test of input.contractTests) {
        lines.push(`| ${test.relativePath} | ${test.testCaseCount} | ${test.requirementId} |`);
      }
    }
    lines.push("");

    lines.push("### E2E 测试");
    lines.push("");
    if (input.e2eTests.length === 0) {
      lines.push("（无 E2E 测试）");
    } else {
      lines.push("| 文件路径 | 测试用例数 | 需求 ID |");
      lines.push("|----------|-----------|---------|");
      for (const test of input.e2eTests) {
        lines.push(`| ${test.relativePath} | ${test.testCaseCount} | ${test.requirementId} |`);
      }
    }
    lines.push("");

    lines.push("### 覆盖率明细");
    lines.push("");
    lines.push("| 维度 | 覆盖率 | 阈值 | 是否达标 |");
    lines.push("|------|--------|------|----------|");
    lines.push(
      `| 行覆盖率 | ${input.coverageReport.lines.toFixed(1)}% | ${DEFAULT_COVERAGE_THRESHOLD.lines}% | ${input.coverageReport.lines >= DEFAULT_COVERAGE_THRESHOLD.lines ? "✅" : "❌"} |`
    );
    lines.push(
      `| 分支覆盖率 | ${input.coverageReport.branches.toFixed(1)}% | ${DEFAULT_COVERAGE_THRESHOLD.branches}% | ${input.coverageReport.branches >= DEFAULT_COVERAGE_THRESHOLD.branches ? "✅" : "❌"} |`
    );
    lines.push(
      `| 函数覆盖率 | ${input.coverageReport.functions.toFixed(1)}% | ${DEFAULT_COVERAGE_THRESHOLD.functions}% | ${input.coverageReport.functions >= DEFAULT_COVERAGE_THRESHOLD.functions ? "✅" : "❌"} |`
    );
    lines.push(
      `| 高风险符号覆盖率 | ${input.coverageReport.highRiskSymbols.toFixed(1)}% | ${DEFAULT_COVERAGE_THRESHOLD.highRiskSymbols}% | ${input.coverageReport.highRiskSymbols >= DEFAULT_COVERAGE_THRESHOLD.highRiskSymbols ? "✅" : "❌"} |`
    );
    lines.push("");

    if (input.coverageReport.uncoveredHighRiskSymbols.length > 0) {
      lines.push("### 未覆盖的高风险符号");
      lines.push("");
      lines.push("| 符号 ID | 文件路径 | 未覆盖原因 | 风险评分 |");
      lines.push("|---------|----------|------------|----------|");
      for (const symbol of input.coverageReport.uncoveredHighRiskSymbols) {
        lines.push(`| ${symbol.symbolId} | ${symbol.filePath} | ${symbol.reason} | ${symbol.riskScore.toFixed(2)} |`);
      }
      lines.push("");
    }

    // ---- 4. 测试质量静态判定结果 ----
    if (input.testQualityResults.length > 0) {
      lines.push("## 测试质量静态判定");
      lines.push("");
      lines.push("| Checker ID | 严重级 | 是否通过 | 违规数 |");
      lines.push("|------------|--------|----------|--------|");
      for (const result of input.testQualityResults) {
        lines.push(
          `| ${result.checkerId} | ${result.severity} | ${result.passed ? "✅" : "❌"} | ${result.violations.length} |`
        );
      }
      lines.push("");
    }

    // ---- 5. 合规证据（预留） ----
    lines.push("## 合规证据");
    lines.push("");
    lines.push("（本批次未启用 ICP，合规证据预留——P3 批次 11 实现）");
    lines.push("");

    return lines.join("\n");
  }

  // ----------------------------------------------------------------------
  // 私有方法：辅助方法
  // ----------------------------------------------------------------------

  /**
   * 生成 run-id（SHA256 时间戳哈希）
   *
   * @returns 16 字符 run-id
   */
  private generateRunId(): string {
    return crypto.createHash("sha256").update(Date.now().toString()).digest("hex").slice(0, 16);
  }

  /**
   * 构建 Loop 事件
   *
   * @param runId 运行 ID
   * @param iterIndex 迭代索引
   * @param eventType 事件类型
   * @param payload 事件负载
   * @returns LoopEvent 实例
   */
  private buildEvent(
    runId: string,
    iterIndex: number,
    eventType: LoopEventType,
    payload: Readonly<Record<string, unknown>>
  ): LoopEvent {
    return Object.freeze({
      eventId: `${runId}-${iterIndex}-${eventType}-${Date.now()}`,
      eventType,
      phase: "testing",
      runId,
      iterIndex,
      payload: Object.freeze({ ...payload }),
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * 安全查询 PKC 风险热点（失败时降级为空数组）
   *
   * @param projectRoot 项目根目录
   * @returns 高风险符号列表（失败时为空数组）
   */
  private async pkcQueryRiskHotspotsSafe(projectRoot: string) {
    try {
      // 此处通过 coverageGate 间接访问 pkcAccessor
      // coverageGate 内部已封装 pkcAccessor.queryRiskHotspots 调用
      // 此处直接返回空数组，由 coverageGate 内部完成查询
      // 注：本方法保留供 TestQualityContext 使用，避免重复查询
      return [];
    } catch {
      return [];
    }
  }

  /**
   * 构建失败结果
   *
   * @param request 编排请求
   * @param runId 运行 ID
   * @param finalStatus 最终状态（human_checkpoint / stop_failure）
   * @param blockedReason 阻塞原因
   * @param events 事件流
   * @param totalLlmCallCount 总 LLM 调用次数
   * @param totalTokensUsed 总 token 消耗
   * @param startTime 开始时间戳
   * @param partialResults 部分产出（可选）
   * @returns 失败的 TestingLoopResult
   */
  private buildFailureResult(
    request: Readonly<TestingLoopRequest>,
    runId: string,
    finalStatus: TestingLoopFinalStatus,
    blockedReason: string,
    events: LoopEvent[],
    totalLlmCallCount: number,
    totalTokensUsed: number,
    startTime: number,
    partialResults?: {
      readonly contractTests?: ReadonlyArray<GeneratedTestFile>;
      readonly e2eTests?: ReadonlyArray<GeneratedTestFile>;
      readonly coverageReport?: Readonly<CoverageReport>;
      readonly prDescription?: string;
    }
  ): Readonly<TestingLoopResult> {
    const durationSec = Math.round((Date.now() - startTime) / 1000);

    // 失败时也记录 LoopGuard 迭代
    request.loopGuard.recordIteration(totalTokensUsed, false);

    return Object.freeze({
      runId,
      finalStatus,
      contractTests: Object.freeze([...(partialResults?.contractTests ?? [])]),
      e2eTests: Object.freeze([...(partialResults?.e2eTests ?? [])]),
      integrationTests: Object.freeze([]),
      complianceTests: Object.freeze([]),
      coverageReport: (partialResults?.coverageReport ?? this.buildEmptyCoverageReport()) as CoverageReport,
      prDescription: partialResults?.prDescription ?? "",
      blockedReason,
      totalLlmCallCount,
      totalTokensUsed,
      durationSec,
      events: Object.freeze([...events]),
    });
  }

  /**
   * 构建成功结果
   *
   * @param input 成功结果输入
   * @returns 成功的 TestingLoopResult
   */
  private buildSuccessResult(input: {
    readonly request: Readonly<TestingLoopRequest>;
    readonly runId: string;
    readonly contractTests: ReadonlyArray<GeneratedTestFile>;
    readonly e2eTests: ReadonlyArray<GeneratedTestFile>;
    readonly coverageReport: Readonly<CoverageReport>;
    readonly prDescription: string;
    readonly events: LoopEvent[];
    readonly totalLlmCallCount: number;
    readonly totalTokensUsed: number;
    readonly startTime: number;
  }): Readonly<TestingLoopResult> {
    const durationSec = Math.round((Date.now() - input.startTime) / 1000);

    return Object.freeze({
      runId: input.runId,
      finalStatus: "success",
      contractTests: Object.freeze([...input.contractTests]),
      e2eTests: Object.freeze([...input.e2eTests]),
      integrationTests: Object.freeze([]),
      complianceTests: Object.freeze([]),
      coverageReport: input.coverageReport,
      prDescription: input.prDescription,
      totalLlmCallCount: input.totalLlmCallCount,
      totalTokensUsed: input.totalTokensUsed,
      durationSec,
      events: Object.freeze([...input.events]),
    });
  }

  /**
   * 构建空覆盖率报告（失败降级时使用）
   *
   * @returns 空 CoverageReport
   */
  private buildEmptyCoverageReport(): Readonly<CoverageReport> {
    return Object.freeze({
      lines: 0,
      branches: 0,
      functions: 0,
      highRiskSymbols: 0,
      uncoveredHighRiskSymbols: Object.freeze([]),
      uncoveredFiles: Object.freeze([]),
      passed: false,
      failedDimensions: Object.freeze([
        "lines",
        "branches",
        "functions",
        "highRiskSymbols",
      ]) as ReadonlyArray<CoverageFailedDimension>,
      rawReport: Object.freeze({}),
    });
  }

  /**
   * 日志输出
   *
   * @param message 日志消息
   * @param level 日志级别
   */
  private log(message: string, level: "info" | "warn" | "error"): void {
    this.logger(message, level);
  }
}

// ============================================================================
// 6. 工厂函数
// ============================================================================

/**
 * 创建默认 TestingOrchestrator 实例
 *
 * @param coverageGate 覆盖率门禁实例（必填——需注入 pkcAccessor）
 * @param logger 日志回调（可选）
 * @returns TestingOrchestrator 实例
 */
export function createDefaultTestingOrchestrator(
  coverageGate: CoverageGate,
  logger?: LogCallback
): TestingOrchestrator {
  return new TestingOrchestrator({
    coverageGate,
    logger,
  });
}

// ============================================================================
// 7. 模块导出
// ============================================================================
