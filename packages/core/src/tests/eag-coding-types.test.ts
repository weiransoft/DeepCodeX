/**
 * EAG-P2 批次 9 S1 单元测试：CODING Loop 数据模型（eag/coding/types.ts）
 *
 * 测试范围：
 * - T1. GeneratedFileKind 字面量联合完整性（13 种 + 顺序 + 冻结）
 * - T2. FillPlaceholderKind 字面量联合完整性（4 种 + 顺序 + 冻结）
 * - T3. FillStatusValue 字面量联合完整性（3 种 + 顺序 + 冻结）
 * - T4. CodingLoopFinalStatus / TaskCodingStatus 字面量联合完整性
 * - T5. GeneratedFile 接口字段完整性
 * - T6. FillPlaceholder 接口字段完整性（含可选 expectedSignature）
 * - T7. SkeletonGenerationRequest / SkeletonGenerationResult 接口字段完整性
 * - T8. LlmFillRequest / LlmFillResult / FillStatus 接口字段完整性
 * - T9. CodingContext 及子结构（SemanticSearchHit / TcsSpecSummary / RlisRuleSummary）字段完整性
 * - T10. StrictEvaluationRequest 接口字段完整性（llmClient 可选）
 * - T11. FixLoopRequest / FixRoundRecord / FixLoopResult 接口字段完整性
 * - T12. CodingLoopRequest / TaskCodingResult / CodingLoopResult 接口字段完整性
 * - T13. PkcAccessor 协议真实实现可用性
 * - T14. TemplateVariableSchema / TemplateRegistry 协议真实实现可用性
 * - T15. StaticChecker 协议真实实现可用性
 * - T16. 默认配置常量值（8 个 as const 常量）
 * - T17. CODING_DEFAULTS 汇总常量（冻结 + 字段完整性 + 与单项常量一致性）
 * - T18. createSkeletonGenerationRequest 工厂（成功冻结 + 各字段校验失败）
 * - T19. createLlmFillRequest 工厂（成功冻结 + 校验失败）
 * - T20. createCodingLoopRequest 工厂（成功冻结 + 数组拷贝冻结）
 * - T21. 请求校验错误类（SkeletonRequestError / LlmFillRequestError / CodingLoopRequestError）
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止 mock，直接构造真实对象（真实 InMemoryLLMClient / 真实 LoopGuard / 真实协议实现）
 * - 每个测试用例独立构造 fixture，避免相互依赖
 *
 * @module core/tests/eag-coding-types
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GENERATED_FILE_KINDS,
  FILL_PLACEHOLDER_KINDS,
  FILL_STATUS_VALUES,
  CODING_LOOP_FINAL_STATUSES,
  TASK_CODING_STATUSES,
  DEFAULT_MAX_FILL_ROUNDS,
  DEFAULT_MAX_TOKENS_PER_FILE,
  DEFAULT_MAX_FIX_ROUNDS,
  DEFAULT_MAX_CODING_ITERATIONS,
  DEFAULT_CODE_GENERATION_TEMPERATURE,
  DEFAULT_MAX_TOKENS_PER_LLM_CALL,
  DEFAULT_L2_SEARCH_TOP_K,
  L2_SCORE_FILTER_THRESHOLD,
  FIX_CONTEXT_WINDOW_SIZE,
  SAME_REDLINE_CONSECUTIVE_VIOLATION_LIMIT,
  CODING_DEFAULTS,
  createSkeletonGenerationRequest,
  createLlmFillRequest,
  createCodingLoopRequest,
  SkeletonRequestError,
  LlmFillRequestError,
  CodingLoopRequestError,
} from "../eag/coding/types";
import type {
  GeneratedFile,
  GeneratedFileKind,
  FillPlaceholder,
  FillPlaceholderKind,
  FillStatusValue,
  FillStatus,
  SkeletonGenerationRequest,
  SkeletonGenerationResult,
  LlmFillRequest,
  LlmFillResult,
  CodingContext,
  SemanticSearchHit,
  TcsSpecSummary,
  RlisRuleSummary,
  StrictEvaluationRequest,
  FixLoopRequest,
  FixRoundRecord,
  FixLoopResult,
  CodingLoopFinalStatus,
  TaskCodingStatus,
  CodingLoopRequest,
  TaskCodingResult,
  CodingLoopResult,
  PkcAccessor,
  TemplateVariableSchema,
  TemplateRegistry,
  StaticChecker,
} from "../eag/coding/types";
import type { TaskCard, TaskDag, ModuleSplit } from "../eag/doc-driven/types";
import type { EvaluationReport, EvaluationContext, RedlineDefinition, RedlineResult } from "../eag/evaluator/types";
import { InMemoryLLMClient } from "../eag/coding/llm-filler";
import { LoopGuard } from "../common/loop-guard";

// ============================================================================
// 辅助函数：构造测试 fixture（真实对象，非 mock）
// ============================================================================

/**
 * 构造测试用 TaskCard
 *
 * @param overrides 覆盖字段（默认构造最小合法任务卡）
 * @returns 完整的 TaskCard
 */
function createTaskCard(overrides: Partial<TaskCard> = {}): TaskCard {
  return {
    id: "T-001",
    title: "OrderAggregate 骨架生成",
    requirementId: "F-001",
    dependencies: [],
    acceptanceCriteria: ["npm test order-aggregate"],
    status: "pending",
    declaredSymbols: [],
    ...overrides,
  };
}

/**
 * 构造测试用 TaskDag（单节点无依赖）
 *
 * @returns 完整的 TaskDag
 */
function createTaskDag(): TaskDag {
  return {
    nodes: [
      {
        id: "T-001",
        title: "OrderAggregate 骨架生成",
        requirementId: "F-001",
        dependencies: [],
        fileCluster: "OrderAggregate",
        acceptanceCommand: "npm test order-aggregate",
        declaredSymbols: [],
      },
    ],
    topologicalOrder: ["T-001"],
  };
}

/**
 * 构造测试用 ModuleSplit
 *
 * @returns 完整的 ModuleSplit
 */
function createModuleSplit(): ModuleSplit {
  return {
    moduleName: "OrderAggregate",
    responsibility: "订单聚合根：订单创建 / 状态流转 / 领域事件发布",
    dependsOn: [],
    keyFiles: ["src/domain/order/OrderAggregate.ts"],
  };
}

/**
 * 构造测试用 RedlineDefinition
 *
 * @param id 红线 ID（默认 "E1"）
 * @returns 完整的 RedlineDefinition
 */
function createRedline(id: string = "E1"): RedlineDefinition {
  return {
    id,
    name: "事务边界",
    description: "跨聚合写操作必须通过 Saga 编排，禁止聚合间直接写调用",
    severity: "blocker",
    checkMethod: "AST 静态分析跨聚合写调用",
    checkType: "static",
    fixGuidance: "将跨聚合写调用改为 Saga 编排步骤",
  };
}

/**
 * 构造测试用 EvaluationReport
 *
 * @param verdict 评估结论（默认 "pass"）
 * @returns 完整的 EvaluationReport
 */
function createEvaluationReport(verdict: EvaluationReport["verdict"] = "pass"): EvaluationReport {
  return {
    verdict,
    redlineResults: [
      {
        redlineId: "E1",
        status: verdict === "pass" ? "passed" : "violated",
        violations: [],
        evidence: "未发现跨聚合写调用",
      },
    ],
    blockerCount: verdict === "pass" ? 0 : 1,
    majorCount: 0,
    warningCount: 0,
    durationMs: 120,
  };
}

/**
 * 构造测试用 GeneratedFile
 *
 * @param overrides 覆盖字段
 * @returns 完整的 GeneratedFile
 */
function createGeneratedFile(overrides: Partial<GeneratedFile> = {}): GeneratedFile {
  return {
    relativePath: "src/domain/order/OrderAggregate.ts",
    content: "/** OrderAggregate 聚合根 */\nexport class OrderAggregate {}",
    kind: "aggregate",
    taskId: "T-001",
    requirementId: "F-001",
    ...overrides,
  };
}

/**
 * 构造测试用 FillPlaceholder
 *
 * @param overrides 覆盖字段
 * @returns 完整的 FillPlaceholder
 */
function createFillPlaceholder(overrides: Partial<FillPlaceholder> = {}): FillPlaceholder {
  return {
    id: "PH-001",
    filePath: "src/domain/order/OrderAggregate.ts",
    line: 25,
    kind: "method-body",
    description: "实现 OrderAggregate.create 工厂方法，包含不变式校验与领域事件发布",
    expectedSignature:
      "static create(command: OrderCreateCommand): { aggregate: OrderAggregate; events: DomainEvent[] }",
    ...overrides,
  };
}

/**
 * 构造测试用 SkeletonGenerationResult
 *
 * @returns 完整的 SkeletonGenerationResult
 */
function createSkeletonResult(): SkeletonGenerationResult {
  return {
    files: [createGeneratedFile()],
    templateVariables: { aggregateName: "OrderAggregate", fields: ["orderId", "status"] },
    fillPlaceholders: [createFillPlaceholder()],
    durationMs: 320,
  };
}

/**
 * 构造测试用 CodingContext
 *
 * @returns 完整的 CodingContext
 */
function createCodingContext(): CodingContext {
  return {
    l1GlobalView: { moduleClusters: [], entryPoints: [] },
    l2SemanticResults: [],
    l3BusinessKnowledge: { flows: [], erDiagram: "" },
    tcsSpecs: [],
    rlisRules: [],
    enterpriseRedlines: [createRedline()],
    taskCard: createTaskCard(),
    moduleSplit: createModuleSplit(),
  };
}

/**
 * 内存版 PKC 访问器（真实实现，非 mock）
 *
 * 所有方法真实工作：返回注入的预设数据，未注入时返回空结构。
 */
class TestPkcAccessor implements PkcAccessor {
  async queryL1GlobalView(_projectRoot: string): Promise<Readonly<Record<string, unknown>>> {
    return { moduleClusters: ["order"], entryPoints: ["src/index.ts"] };
  }

  async searchL2(_query: string, _projectRoot: string, topK?: number): Promise<ReadonlyArray<SemanticSearchHit>> {
    const hits: SemanticSearchHit[] = [
      {
        symbolId: "src/domain/order/OrderAggregate.ts:OrderAggregate.create",
        filePath: "src/domain/order/OrderAggregate.ts",
        signature: "static create(command: OrderCreateCommand): OrderAggregate",
        score: 0.92,
        snippet: "static create(command: OrderCreateCommand) { ... }",
      },
    ];
    return hits.slice(0, topK ?? hits.length);
  }

  async queryL3BusinessKnowledge(_projectRoot: string): Promise<Readonly<Record<string, unknown>>> {
    return { flows: ["下单流程"], erDiagram: "Order ||--|{ OrderItem" };
  }
}

// ============================================================================
// T1. GeneratedFileKind 字面量联合完整性（13 种）
// ============================================================================

test("T1a. GENERATED_FILE_KINDS 包含 13 种文件类型", () => {
  assert.equal(GENERATED_FILE_KINDS.length, 13);
});

test("T1b. GENERATED_FILE_KINDS 顺序对齐 §4.1.2 定义顺序", () => {
  const expected: ReadonlyArray<GeneratedFileKind> = [
    "aggregate",
    "value-object",
    "domain-event",
    "domain-service",
    "repository-port",
    "repository-impl",
    "application-service",
    "dto",
    "rest-controller",
    "saga-orchestrator",
    "event-handler",
    "test-spec",
    "module-index",
  ];
  assert.deepEqual([...GENERATED_FILE_KINDS], [...expected]);
});

test("T1c. GENERATED_FILE_KINDS 已冻结（Object.isFrozen）", () => {
  assert.equal(Object.isFrozen(GENERATED_FILE_KINDS), true);
});

// ============================================================================
// T2. FillPlaceholderKind 字面量联合完整性（4 种）
// ============================================================================

test("T2a. FILL_PLACEHOLDER_KINDS 包含 4 种占位类型", () => {
  assert.equal(FILL_PLACEHOLDER_KINDS.length, 4);
});

test("T2b. FILL_PLACEHOLDER_KINDS 顺序正确（method-body/class-body/config/import）", () => {
  const expected: ReadonlyArray<FillPlaceholderKind> = ["method-body", "class-body", "config", "import"];
  assert.deepEqual([...FILL_PLACEHOLDER_KINDS], [...expected]);
});

test("T2c. FILL_PLACEHOLDER_KINDS 已冻结（Object.isFrozen）", () => {
  assert.equal(Object.isFrozen(FILL_PLACEHOLDER_KINDS), true);
});

// ============================================================================
// T3. FillStatusValue 字面量联合完整性（3 种）
// ============================================================================

test("T3a. FILL_STATUS_VALUES 包含 3 种填充状态", () => {
  assert.equal(FILL_STATUS_VALUES.length, 3);
});

test("T3b. FILL_STATUS_VALUES 顺序正确（filled/skipped/failed）", () => {
  const expected: ReadonlyArray<FillStatusValue> = ["filled", "skipped", "failed"];
  assert.deepEqual([...FILL_STATUS_VALUES], [...expected]);
});

test("T3c. FILL_STATUS_VALUES 已冻结（Object.isFrozen）", () => {
  assert.equal(Object.isFrozen(FILL_STATUS_VALUES), true);
});

// ============================================================================
// T4. CodingLoopFinalStatus / TaskCodingStatus 字面量联合完整性
// ============================================================================

test("T4a. CODING_LOOP_FINAL_STATUSES 覆盖 completed/failed/human-checkpoint 且已冻结", () => {
  const expected: ReadonlyArray<CodingLoopFinalStatus> = ["completed", "failed", "human-checkpoint"];
  assert.deepEqual([...CODING_LOOP_FINAL_STATUSES], [...expected]);
  assert.equal(Object.isFrozen(CODING_LOOP_FINAL_STATUSES), true);
});

test("T4b. TASK_CODING_STATUSES 覆盖 completed/fix-exhausted/human-checkpoint 且已冻结", () => {
  const expected: ReadonlyArray<TaskCodingStatus> = ["completed", "fix-exhausted", "human-checkpoint"];
  assert.deepEqual([...TASK_CODING_STATUSES], [...expected]);
  assert.equal(Object.isFrozen(TASK_CODING_STATUSES), true);
});

// ============================================================================
// T5. GeneratedFile 接口字段完整性
// ============================================================================

test("T5. GeneratedFile 接口字段完整性（5 个必填字段）", () => {
  const file: GeneratedFile = createGeneratedFile();
  assert.equal(file.relativePath, "src/domain/order/OrderAggregate.ts");
  assert.ok(file.content.includes("OrderAggregate"));
  assert.equal(file.kind, "aggregate");
  assert.equal(file.taskId, "T-001");
  assert.equal(file.requirementId, "F-001");
});

// ============================================================================
// T6. FillPlaceholder 接口字段完整性
// ============================================================================

test("T6a. FillPlaceholder 必填字段完整性", () => {
  const placeholder: FillPlaceholder = createFillPlaceholder({ expectedSignature: undefined });
  assert.equal(placeholder.id, "PH-001");
  assert.equal(placeholder.filePath, "src/domain/order/OrderAggregate.ts");
  assert.equal(placeholder.line, 25);
  assert.equal(placeholder.kind, "method-body");
  assert.ok(placeholder.description.includes("OrderAggregate.create"));
  assert.equal(placeholder.expectedSignature, undefined);
});

test("T6b. FillPlaceholder 可选 expectedSignature 字段（method-body 时为方法签名）", () => {
  const placeholder: FillPlaceholder = createFillPlaceholder();
  assert.ok(placeholder.expectedSignature?.includes("static create"));
});

// ============================================================================
// T7. SkeletonGenerationRequest / SkeletonGenerationResult 接口字段完整性
// ============================================================================

test("T7a. SkeletonGenerationRequest 接口字段完整性（8 个必填字段）", () => {
  const request: SkeletonGenerationRequest = {
    planContent: "# 实现方案\n## 1. 模块切分",
    tasksContent: "# 任务分解\n## T-001 OrderAggregate 骨架",
    taskDag: createTaskDag(),
    taskCard: createTaskCard(),
    techStack: ["TypeScript", "NestJS", "PostgreSQL"],
    projectRoot: "/path/to/project",
    outputDir: "src/",
  };
  assert.ok(request.planContent.length > 0);
  assert.ok(request.tasksContent.length > 0);
  assert.equal(request.taskDag.nodes.length, 1);
  assert.equal(request.taskCard.id, "T-001");
  assert.equal(request.techStack.length, 3);
  assert.equal(request.projectRoot, "/path/to/project");
  assert.equal(request.outputDir, "src/");
});

test("T7b. SkeletonGenerationResult 接口字段完整性（4 个必填字段）", () => {
  const result: SkeletonGenerationResult = createSkeletonResult();
  assert.equal(result.files.length, 1);
  assert.equal(result.templateVariables.aggregateName, "OrderAggregate");
  assert.equal(result.fillPlaceholders.length, 1);
  assert.equal(result.durationMs, 320);
});

// ============================================================================
// T8. LlmFillRequest / LlmFillResult / FillStatus 接口字段完整性
// ============================================================================

test("T8a. LlmFillRequest 接口字段完整性（真实 InMemoryLLMClient 注入）", () => {
  const llmClient = new InMemoryLLMClient();
  const request: LlmFillRequest = {
    skeleton: createSkeletonResult(),
    context: createCodingContext(),
    llmClient,
    maxRounds: DEFAULT_MAX_FILL_ROUNDS,
    maxTokensPerFile: DEFAULT_MAX_TOKENS_PER_FILE,
  };
  assert.equal(request.skeleton.files.length, 1);
  assert.equal(request.context.taskCard.id, "T-001");
  assert.equal(typeof request.llmClient.createMessage, "function");
  assert.equal(request.maxRounds, 3);
  assert.equal(request.maxTokensPerFile, 4000);
});

test("T8b. LlmFillResult 接口字段完整性（5 个必填字段）", () => {
  const result: LlmFillResult = {
    filledFiles: [createGeneratedFile({ content: "export class OrderAggregate { /* 完整实现 */ }" })],
    fillStatus: [{ placeholderId: "PH-001", status: "filled", summary: "static create(command) { ... }" }],
    llmCallCount: 12,
    totalTokensUsed: 18432,
    durationMs: 4520,
  };
  assert.equal(result.filledFiles.length, 1);
  assert.equal(result.fillStatus.length, 1);
  assert.equal(result.fillStatus[0]?.status, "filled");
  assert.equal(result.llmCallCount, 12);
  assert.equal(result.totalTokensUsed, 18432);
  assert.equal(result.durationMs, 4520);
});

test("T8c. FillStatus 三种状态值均可构造（filled/skipped/failed）", () => {
  const statuses: FillStatus[] = FILL_STATUS_VALUES.map((status) => ({
    placeholderId: "PH-001",
    status,
    summary: `占位状态为 ${status}`,
  }));
  assert.equal(statuses.length, 3);
  assert.equal(statuses[0]?.status, "filled");
  assert.equal(statuses[1]?.status, "skipped");
  assert.equal(statuses[2]?.status, "failed");
});

// ============================================================================
// T9. CodingContext 及子结构字段完整性
// ============================================================================

test("T9a. CodingContext 接口字段完整性（8 个必填字段）", () => {
  const context: CodingContext = createCodingContext();
  assert.ok(typeof context.l1GlobalView === "object");
  assert.equal(context.l2SemanticResults.length, 0);
  assert.ok(typeof context.l3BusinessKnowledge === "object");
  assert.equal(context.tcsSpecs.length, 0);
  assert.equal(context.rlisRules.length, 0);
  assert.equal(context.enterpriseRedlines.length, 1);
  assert.equal(context.taskCard.id, "T-001");
  assert.equal(context.moduleSplit.moduleName, "OrderAggregate");
});

test("T9b. SemanticSearchHit 接口字段完整性（5 个必填字段）", () => {
  const hit: SemanticSearchHit = {
    symbolId: "src/domain/order/OrderAggregate.ts:OrderAggregate.create",
    filePath: "src/domain/order/OrderAggregate.ts",
    signature: "static create(command: OrderCreateCommand): OrderAggregate",
    score: 0.92,
    snippet: "static create(command) { ... }",
  };
  assert.ok(hit.symbolId.includes(":"));
  assert.ok(hit.filePath.endsWith(".ts"));
  assert.ok(hit.signature.includes("create"));
  assert.ok(hit.score >= 0 && hit.score <= 1);
  assert.ok(hit.snippet.length > 0);
});

test("T9c. TcsSpecSummary 接口字段完整性（componentId + portInterface + redlines）", () => {
  const summary: TcsSpecSummary = {
    componentId: "TCS-CACHE",
    portInterface: "interface CachePort { get<T>(key: string): Promise<T | null>; }",
    redlines: [createRedline("TCS-CACHE-01")],
  };
  assert.equal(summary.componentId, "TCS-CACHE");
  assert.ok(summary.portInterface.includes("CachePort"));
  assert.equal(summary.redlines.length, 1);
  assert.equal(summary.redlines[0]?.id, "TCS-CACHE-01");
});

test("T9d. RlisRuleSummary 接口字段完整性（4 个必填字段）", () => {
  const rule: RlisRuleSummary = {
    ruleId: "SEED-01",
    category: "implementation-quality",
    severity: "blocker",
    content: "禁止使用 mock/占位/简化实现，所有代码必须真实实现业务逻辑",
  };
  assert.equal(rule.ruleId, "SEED-01");
  assert.equal(rule.category, "implementation-quality");
  assert.equal(rule.severity, "blocker");
  assert.ok(rule.content.includes("真实实现"));
});

// ============================================================================
// T10. StrictEvaluationRequest 接口字段完整性
// ============================================================================

test("T10a. StrictEvaluationRequest 必填字段（evaluationContext + redlines，llmClient 可省略）", () => {
  const evaluationContext: EvaluationContext = {
    loopType: "coding",
    iteration: 1,
    taskId: "T-001",
    artifactPaths: ["src/domain/order/OrderAggregate.ts"],
  };
  const request: StrictEvaluationRequest = {
    evaluationContext,
    redlines: [createRedline()],
  };
  assert.equal(request.evaluationContext.loopType, "coding");
  assert.equal(request.evaluationContext.iteration, 1);
  assert.equal(request.redlines.length, 1);
  assert.equal(request.llmClient, undefined);
});

test("T10b. StrictEvaluationRequest 可选 llmClient（reasoning 红线判定用）", () => {
  const request: StrictEvaluationRequest = {
    evaluationContext: { loopType: "coding", iteration: 1, taskId: "T-001", artifactPaths: [] },
    redlines: [createRedline()],
    llmClient: new InMemoryLLMClient(),
  };
  assert.equal(typeof request.llmClient?.createMessage, "function");
});

// ============================================================================
// T11. FixLoopRequest / FixRoundRecord / FixLoopResult 接口字段完整性
// ============================================================================

test("T11a. FixLoopRequest 接口字段完整性（5 个必填字段）", () => {
  const request: FixLoopRequest = {
    originalFiles: [createGeneratedFile()],
    evaluationReport: createEvaluationReport("fix"),
    context: createCodingContext(),
    llmClient: new InMemoryLLMClient(),
    maxRounds: DEFAULT_MAX_FIX_ROUNDS,
  };
  assert.equal(request.originalFiles.length, 1);
  assert.equal(request.evaluationReport.verdict, "fix");
  assert.equal(request.context.taskCard.id, "T-001");
  assert.equal(typeof request.llmClient.createMessage, "function");
  assert.equal(request.maxRounds, 3);
});

test("T11b. FixRoundRecord 接口字段完整性（round/inputReport/patch/outputReport/passed）", () => {
  const record: FixRoundRecord = {
    round: 1,
    inputReport: createEvaluationReport("fix"),
    patch: "--- a/src/domain/order/OrderAggregate.ts\n+++ b/src/domain/order/OrderAggregate.ts\n@@ -1 +1 @@",
    outputReport: createEvaluationReport("pass"),
    passed: true,
  };
  assert.equal(record.round, 1);
  assert.equal(record.inputReport.verdict, "fix");
  assert.ok(record.patch.startsWith("---"));
  assert.equal(record.outputReport.verdict, "pass");
  assert.equal(record.passed, true);
});

test("T11c. FixLoopResult 接口字段完整性（5 个必填字段）", () => {
  const result: FixLoopResult = {
    fixedFiles: [createGeneratedFile()],
    rounds: [
      {
        round: 1,
        inputReport: createEvaluationReport("fix"),
        patch: "--- a/x.ts\n+++ b/x.ts",
        outputReport: createEvaluationReport("pass"),
        passed: true,
      },
    ],
    finalReport: createEvaluationReport("pass"),
    totalLlmCallCount: 2,
    durationMs: 3200,
  };
  assert.equal(result.fixedFiles.length, 1);
  assert.equal(result.rounds.length, 1);
  assert.equal(result.finalReport.verdict, "pass");
  assert.equal(result.totalLlmCallCount, 2);
  assert.equal(result.durationMs, 3200);
});

// ============================================================================
// T12. CodingLoopRequest / TaskCodingResult / CodingLoopResult 接口字段完整性
// ============================================================================

test("T12a. CodingLoopRequest 接口字段完整性（13 个必填字段，真实 LoopGuard + InMemoryLLMClient + PkcAccessor）", () => {
  const request: CodingLoopRequest = {
    projectRoot: "/path/to/project",
    specContent: "# 功能需求规格",
    planContent: "# 实现方案",
    tasksContent: "# 任务分解",
    taskDag: createTaskDag(),
    taskCards: [createTaskCard()],
    techStack: ["TypeScript"],
    constitutionContent: "# CONSTITUTION",
    llmClient: new InMemoryLLMClient(),
    pkcAccessor: new TestPkcAccessor(),
    loopGuard: new LoopGuard({ maxIterations: 10 }),
    maxIterations: DEFAULT_MAX_CODING_ITERATIONS,
    maxFixRounds: DEFAULT_MAX_FIX_ROUNDS,
  };
  assert.equal(request.taskCards.length, 1);
  assert.equal(request.taskDag.topologicalOrder[0], "T-001");
  assert.equal(typeof request.llmClient.createMessage, "function");
  assert.equal(typeof request.pkcAccessor.queryL1GlobalView, "function");
  assert.equal(typeof request.loopGuard.check, "function");
  assert.equal(request.maxIterations, 10);
  assert.equal(request.maxFixRounds, 3);
});

test("T12b. TaskCodingResult 接口字段完整性（6 个必填字段）", () => {
  const result: TaskCodingResult = {
    taskCardId: "T-001",
    skeleton: createSkeletonResult(),
    fill: {
      filledFiles: [createGeneratedFile()],
      fillStatus: [],
      llmCallCount: 3,
      totalTokensUsed: 4096,
      durationMs: 1500,
    },
    finalEvaluation: createEvaluationReport("pass"),
    status: "completed",
    iterations: 2,
  };
  assert.equal(result.taskCardId, "T-001");
  assert.equal(result.skeleton.files.length, 1);
  assert.equal(result.fill.filledFiles.length, 1);
  assert.equal(result.finalEvaluation.verdict, "pass");
  assert.equal(result.status, "completed");
  assert.equal(result.iterations, 2);
});

test("T12c. CodingLoopResult 接口字段完整性（8 必填 + 1 可选 blockedReason）", () => {
  const completedResult: CodingLoopResult = {
    taskResults: [],
    allGeneratedFiles: [createGeneratedFile()],
    totalIterations: 5,
    totalLlmCallCount: 28,
    totalTokensUsed: 64200,
    durationSec: 120,
    finalStatus: "completed",
  };
  assert.equal(completedResult.finalStatus, "completed");
  assert.equal(completedResult.blockedReason, undefined);

  // finalStatus != completed 时 blockedReason 描述具体阻塞点
  const blockedResult: CodingLoopResult = {
    ...completedResult,
    finalStatus: "human-checkpoint",
    blockedReason: "任务卡 T-001 FIX 3 轮耗尽，转人工介入",
  };
  assert.equal(blockedResult.finalStatus, "human-checkpoint");
  assert.ok(blockedResult.blockedReason?.includes("T-001"));
});

// ============================================================================
// T13. PkcAccessor 协议真实实现可用性
// ============================================================================

test("T13. PkcAccessor 协议三方法真实可用（queryL1GlobalView / searchL2 / queryL3BusinessKnowledge）", async () => {
  const accessor: PkcAccessor = new TestPkcAccessor();

  // L1 全局视野查询
  const l1 = await accessor.queryL1GlobalView("/path/to/project");
  assert.deepEqual(l1.moduleClusters, ["order"]);

  // L2 语义检索（含 topK 截断）
  const hits = await accessor.searchL2("订单创建流程", "/path/to/project", 10);
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.score, 0.92);
  const topZero = await accessor.searchL2("订单创建流程", "/path/to/project", 0);
  assert.equal(topZero.length, 0);

  // L3 业务知识查询
  const l3 = await accessor.queryL3BusinessKnowledge("/path/to/project");
  assert.deepEqual(l3.flows, ["下单流程"]);
});

// ============================================================================
// T14. TemplateVariableSchema / TemplateRegistry 协议真实实现可用性
// ============================================================================

test("T14. TemplateVariableSchema / TemplateRegistry 协议真实实现可用", () => {
  // 构造真实的 TemplateVariableSchema 实现（校验 variables 必须含 aggregateName 字符串）
  const schema: TemplateVariableSchema = {
    validate(variables) {
      if (typeof variables.aggregateName === "string" && variables.aggregateName.length > 0) {
        return { success: true, data: variables };
      }
      return { success: false, errors: ["aggregateName 必须为非空字符串"] };
    },
  };

  // 合法变量 → success=true
  const okResult = schema.validate({ aggregateName: "OrderAggregate" });
  assert.equal(okResult.success, true);
  assert.equal(okResult.data?.aggregateName, "OrderAggregate");

  // 非法变量 → success=false + errors
  const badResult = schema.validate({ aggregateName: 123 });
  assert.equal(badResult.success, false);
  assert.equal(badResult.errors?.length, 1);

  // 构造真实的 TemplateRegistry 实现（注册 13 种 kind 中的 aggregate）
  const registry: TemplateRegistry = {
    getTemplate(kind: GeneratedFileKind): string {
      if (kind !== "aggregate") {
        throw new Error(`kind 未注册：${kind}`);
      }
      return "export class <%- aggregateName %> {}";
    },
    listKinds(): ReadonlyArray<GeneratedFileKind> {
      return Object.freeze([...GENERATED_FILE_KINDS]);
    },
    getVariableSchema(kind: GeneratedFileKind): TemplateVariableSchema {
      if (kind !== "aggregate") {
        throw new Error(`kind 未注册：${kind}`);
      }
      return schema;
    },
  };

  assert.ok(registry.getTemplate("aggregate").includes("aggregateName"));
  assert.equal(registry.listKinds().length, 13);
  assert.equal(registry.getVariableSchema("aggregate"), schema);
  // 未注册 kind 抛错
  assert.throws(() => registry.getTemplate("dto"), /kind 未注册/);
});

// ============================================================================
// T15. StaticChecker 协议真实实现可用性
// ============================================================================

test("T15. StaticChecker 协议真实实现可用（redlineIds + check 返回 RedlineResult）", () => {
  // 构造真实的 StaticChecker 实现：扫描跨聚合写调用（禁止 import 其他聚合）
  const checker: StaticChecker = {
    redlineIds: Object.freeze(["E1"]),
    check(
      artifacts: ReadonlyArray<{ readonly path: string; readonly content: string }>,
      redline: Readonly<RedlineDefinition>
    ): RedlineResult {
      const violations = artifacts
        .filter((a) => a.content.includes("import") && a.content.includes("Aggregate"))
        .map((a) => ({
          filePath: a.path,
          description: "检测到跨聚合 import 写调用",
          fixSuggestion: "改为 Saga 编排步骤",
        }));
      return {
        redlineId: redline.id,
        status: violations.length > 0 ? "violated" : "passed",
        violations,
      };
    },
  };

  assert.deepEqual([...checker.redlineIds], ["E1"]);

  // 干净产出物 → passed
  const passResult = checker.check(
    [{ path: "src/domain/order/OrderAggregate.ts", content: "export class OrderAggregate {}" }],
    createRedline()
  );
  assert.equal(passResult.status, "passed");
  assert.equal(passResult.violations.length, 0);

  // 含跨聚合 import → violated
  const violatedResult = checker.check(
    [
      {
        path: "src/domain/order/OrderService.ts",
        content: 'import { UserAggregate } from "../user/UserAggregate";',
      },
    ],
    createRedline()
  );
  assert.equal(violatedResult.status, "violated");
  assert.equal(violatedResult.violations.length, 1);
  assert.equal(violatedResult.violations[0]?.filePath, "src/domain/order/OrderService.ts");
});

// ============================================================================
// T16. 默认配置常量值（8 个 as const 常量）
// ============================================================================

test("T16a. 填充与 FIX 上限常量（DEFAULT_MAX_FILL_ROUNDS=3 / DEFAULT_MAX_FIX_ROUNDS=3）", () => {
  assert.equal(DEFAULT_MAX_FILL_ROUNDS, 3);
  assert.equal(DEFAULT_MAX_FIX_ROUNDS, 3);
});

test("T16b. Token 上限常量（DEFAULT_MAX_TOKENS_PER_FILE=4000 / DEFAULT_MAX_TOKENS_PER_LLM_CALL=8000）", () => {
  assert.equal(DEFAULT_MAX_TOKENS_PER_FILE, 4000);
  assert.equal(DEFAULT_MAX_TOKENS_PER_LLM_CALL, 8000);
});

test("T16c. 迭代与温度常量（DEFAULT_MAX_CODING_ITERATIONS=10 / DEFAULT_CODE_GENERATION_TEMPERATURE=0.2）", () => {
  assert.equal(DEFAULT_MAX_CODING_ITERATIONS, 10);
  assert.equal(DEFAULT_CODE_GENERATION_TEMPERATURE, 0.2);
});

test("T16d. L2 检索与 FIX 窗口常量（TOP_K=10 / 阈值=0.5 / 窗口=2 / 连续违规=2）", () => {
  assert.equal(DEFAULT_L2_SEARCH_TOP_K, 10);
  assert.equal(L2_SCORE_FILTER_THRESHOLD, 0.5);
  assert.equal(FIX_CONTEXT_WINDOW_SIZE, 2);
  assert.equal(SAME_REDLINE_CONSECUTIVE_VIOLATION_LIMIT, 2);
});

// ============================================================================
// T17. CODING_DEFAULTS 汇总常量
// ============================================================================

test("T17a. CODING_DEFAULTS 包含全部 10 个默认值字段", () => {
  assert.equal(CODING_DEFAULTS.maxFillRounds, 3);
  assert.equal(CODING_DEFAULTS.maxTokensPerFile, 4000);
  assert.equal(CODING_DEFAULTS.maxFixRounds, 3);
  assert.equal(CODING_DEFAULTS.maxCodingIterations, 10);
  assert.equal(CODING_DEFAULTS.codeGenerationTemperature, 0.2);
  assert.equal(CODING_DEFAULTS.maxTokensPerLlmCall, 8000);
  assert.equal(CODING_DEFAULTS.l2SearchTopK, 10);
  assert.equal(CODING_DEFAULTS.l2ScoreFilterThreshold, 0.5);
  assert.equal(CODING_DEFAULTS.fixContextWindowSize, 2);
  assert.equal(CODING_DEFAULTS.sameRedlineConsecutiveViolationLimit, 2);
});

test("T17b. CODING_DEFAULTS 与单项常量完全一致", () => {
  assert.equal(CODING_DEFAULTS.maxFillRounds, DEFAULT_MAX_FILL_ROUNDS);
  assert.equal(CODING_DEFAULTS.maxTokensPerFile, DEFAULT_MAX_TOKENS_PER_FILE);
  assert.equal(CODING_DEFAULTS.maxFixRounds, DEFAULT_MAX_FIX_ROUNDS);
  assert.equal(CODING_DEFAULTS.maxCodingIterations, DEFAULT_MAX_CODING_ITERATIONS);
  assert.equal(CODING_DEFAULTS.codeGenerationTemperature, DEFAULT_CODE_GENERATION_TEMPERATURE);
  assert.equal(CODING_DEFAULTS.maxTokensPerLlmCall, DEFAULT_MAX_TOKENS_PER_LLM_CALL);
  assert.equal(CODING_DEFAULTS.l2SearchTopK, DEFAULT_L2_SEARCH_TOP_K);
  assert.equal(CODING_DEFAULTS.l2ScoreFilterThreshold, L2_SCORE_FILTER_THRESHOLD);
  assert.equal(CODING_DEFAULTS.fixContextWindowSize, FIX_CONTEXT_WINDOW_SIZE);
  assert.equal(CODING_DEFAULTS.sameRedlineConsecutiveViolationLimit, SAME_REDLINE_CONSECUTIVE_VIOLATION_LIMIT);
});

test("T17c. CODING_DEFAULTS 已冻结（Object.isFrozen，防止运行期被 LLM 自改）", () => {
  assert.equal(Object.isFrozen(CODING_DEFAULTS), true);
});

// ============================================================================
// T18. createSkeletonGenerationRequest 工厂函数
// ============================================================================

test("T18a. createSkeletonGenerationRequest 合法输入 → 返回冻结对象且 techStack 拷贝冻结", () => {
  const techStack = ["TypeScript", "NestJS"];
  const request = createSkeletonGenerationRequest({
    planContent: "# 实现方案",
    tasksContent: "# 任务分解",
    taskDag: createTaskDag(),
    taskCard: createTaskCard(),
    techStack,
    projectRoot: "/path/to/project",
    outputDir: "src/",
  });

  // 返回值冻结（对齐 G-A6d 配置冻结原则）
  assert.equal(Object.isFrozen(request), true);
  // techStack 为拷贝后的冻结数组（原数组修改不影响请求）
  assert.equal(Object.isFrozen(request.techStack), true);
  assert.notEqual(request.techStack, techStack);
  assert.deepEqual([...request.techStack], techStack);
  assert.equal(request.taskCard.id, "T-001");
});

test("T18b. createSkeletonGenerationRequest planContent 为空 → 抛 SkeletonRequestError", () => {
  assert.throws(
    () =>
      createSkeletonGenerationRequest({
        planContent: "   ",
        tasksContent: "# 任务分解",
        taskDag: createTaskDag(),
        taskCard: createTaskCard(),
        techStack: [],
        projectRoot: "/path/to/project",
        outputDir: "src/",
      }),
    (error: unknown) => {
      assert.ok(error instanceof SkeletonRequestError);
      assert.equal((error as SkeletonRequestError).field, "planContent");
      return true;
    }
  );
});

test("T18c. createSkeletonGenerationRequest taskDag 缺 topologicalOrder → 抛 SkeletonRequestError", () => {
  assert.throws(
    () =>
      createSkeletonGenerationRequest({
        planContent: "# 实现方案",
        tasksContent: "# 任务分解",
        taskDag: { nodes: [] } as unknown as TaskDag,
        taskCard: createTaskCard(),
        techStack: [],
        projectRoot: "/path/to/project",
        outputDir: "src/",
      }),
    (error: unknown) => {
      assert.ok(error instanceof SkeletonRequestError);
      assert.equal((error as SkeletonRequestError).field, "taskDag");
      return true;
    }
  );
});

test("T18d. createSkeletonGenerationRequest taskCard.id 为空 / techStack 非数组 / projectRoot 为空 → 均抛错", () => {
  const baseInput = {
    planContent: "# 实现方案",
    tasksContent: "# 任务分解",
    taskDag: createTaskDag(),
    taskCard: createTaskCard(),
    techStack: ["TypeScript"],
    projectRoot: "/path/to/project",
    outputDir: "src/",
  };

  // taskCard.id 为空字符串
  assert.throws(
    () => createSkeletonGenerationRequest({ ...baseInput, taskCard: createTaskCard({ id: "  " }) }),
    (error: unknown) => error instanceof SkeletonRequestError && (error as SkeletonRequestError).field === "taskCard"
  );
  // techStack 非数组
  assert.throws(
    () =>
      createSkeletonGenerationRequest({ ...baseInput, techStack: "TypeScript" as unknown as ReadonlyArray<string> }),
    (error: unknown) => error instanceof SkeletonRequestError && (error as SkeletonRequestError).field === "techStack"
  );
  // projectRoot 为空
  assert.throws(
    () => createSkeletonGenerationRequest({ ...baseInput, projectRoot: "" }),
    (error: unknown) => error instanceof SkeletonRequestError && (error as SkeletonRequestError).field === "projectRoot"
  );
  // outputDir 为空
  assert.throws(
    () => createSkeletonGenerationRequest({ ...baseInput, outputDir: "" }),
    (error: unknown) => error instanceof SkeletonRequestError && (error as SkeletonRequestError).field === "outputDir"
  );
});

// ============================================================================
// T19. createLlmFillRequest 工厂函数
// ============================================================================

test("T19a. createLlmFillRequest 合法输入 → 返回冻结对象", () => {
  const request = createLlmFillRequest({
    skeleton: createSkeletonResult(),
    context: createCodingContext(),
    llmClient: new InMemoryLLMClient(),
    maxRounds: 3,
    maxTokensPerFile: 4000,
  });
  assert.equal(Object.isFrozen(request), true);
  assert.equal(request.maxRounds, 3);
  assert.equal(request.skeleton.files.length, 1);
});

test("T19b. createLlmFillRequest 非法输入 → 抛 LlmFillRequestError（skeleton / llmClient / maxRounds）", () => {
  const validInput = {
    skeleton: createSkeletonResult(),
    context: createCodingContext(),
    llmClient: new InMemoryLLMClient(),
    maxRounds: 3,
    maxTokensPerFile: 4000,
  };

  // skeleton 缺 files 数组
  assert.throws(
    () =>
      createLlmFillRequest({
        ...validInput,
        skeleton: {} as unknown as SkeletonGenerationResult,
      }),
    (error: unknown) => error instanceof LlmFillRequestError && (error as LlmFillRequestError).field === "skeleton"
  );
  // llmClient 未实现 createMessage
  assert.throws(
    () =>
      createLlmFillRequest({
        ...validInput,
        llmClient: {} as unknown as InMemoryLLMClient,
      }),
    (error: unknown) => error instanceof LlmFillRequestError && (error as LlmFillRequestError).field === "llmClient"
  );
  // maxRounds < 1
  assert.throws(
    () => createLlmFillRequest({ ...validInput, maxRounds: 0 }),
    (error: unknown) => error instanceof LlmFillRequestError && (error as LlmFillRequestError).field === "maxRounds"
  );
  // maxTokensPerFile < 1
  assert.throws(
    () => createLlmFillRequest({ ...validInput, maxTokensPerFile: 0 }),
    (error: unknown) =>
      error instanceof LlmFillRequestError && (error as LlmFillRequestError).field === "maxTokensPerFile"
  );
});

// ============================================================================
// T20. createCodingLoopRequest 工厂函数
// ============================================================================

test("T20a. createCodingLoopRequest 合法输入 → 返回冻结对象且 taskCards/techStack 拷贝冻结", () => {
  const taskCards = [createTaskCard()];
  const techStack = ["TypeScript"];
  const request = createCodingLoopRequest({
    projectRoot: "/path/to/project",
    specContent: "# 功能需求规格",
    planContent: "# 实现方案",
    tasksContent: "# 任务分解",
    taskDag: createTaskDag(),
    taskCards,
    techStack,
    constitutionContent: "# CONSTITUTION",
    llmClient: new InMemoryLLMClient(),
    pkcAccessor: new TestPkcAccessor(),
    loopGuard: new LoopGuard({ maxIterations: 10 }),
    maxIterations: 10,
    maxFixRounds: 3,
  });

  assert.equal(Object.isFrozen(request), true);
  // taskCards / techStack 均为拷贝后的冻结数组（原数组修改不影响请求）
  assert.equal(Object.isFrozen(request.taskCards), true);
  assert.equal(Object.isFrozen(request.techStack), true);
  assert.notEqual(request.taskCards, taskCards);
  assert.notEqual(request.techStack, techStack);
  assert.equal(request.taskCards.length, 1);
});

test("T20b. createCodingLoopRequest 非法输入 → 抛 CodingLoopRequestError（taskCards 空 / maxIterations 非数）", () => {
  const validInput: CodingLoopRequest = {
    projectRoot: "/path/to/project",
    specContent: "# 功能需求规格",
    planContent: "# 实现方案",
    tasksContent: "# 任务分解",
    taskDag: createTaskDag(),
    taskCards: [createTaskCard()],
    techStack: ["TypeScript"],
    constitutionContent: "# CONSTITUTION",
    llmClient: new InMemoryLLMClient(),
    pkcAccessor: new TestPkcAccessor(),
    loopGuard: new LoopGuard({ maxIterations: 10 }),
    maxIterations: 10,
    maxFixRounds: 3,
  };

  // taskCards 为空数组
  assert.throws(
    () => createCodingLoopRequest({ ...validInput, taskCards: [] }),
    (error: unknown) =>
      error instanceof CodingLoopRequestError && (error as CodingLoopRequestError).field === "taskCards"
  );
  // maxIterations < 1
  assert.throws(
    () => createCodingLoopRequest({ ...validInput, maxIterations: 0 }),
    (error: unknown) =>
      error instanceof CodingLoopRequestError && (error as CodingLoopRequestError).field === "maxIterations"
  );
  // pkcAccessor 未实现协议
  assert.throws(
    () => createCodingLoopRequest({ ...validInput, pkcAccessor: {} as unknown as PkcAccessor }),
    (error: unknown) =>
      error instanceof CodingLoopRequestError && (error as CodingLoopRequestError).field === "pkcAccessor"
  );
});

// ============================================================================
// T21. 请求校验错误类字段完整性
// ============================================================================

test("T21. 三个请求校验错误类均含 field/value/reason 字段且 name 正确", () => {
  const skeletonError = new SkeletonRequestError("planContent", "", "必须为非空字符串");
  assert.equal(skeletonError.name, "SkeletonRequestError");
  assert.equal(skeletonError.field, "planContent");
  assert.equal(skeletonError.value, "");
  assert.equal(skeletonError.reason, "必须为非空字符串");
  assert.ok(skeletonError.message.includes("planContent"));
  assert.ok(skeletonError instanceof Error);

  const fillError = new LlmFillRequestError("maxRounds", 0, "必须为 ≥1 的数字");
  assert.equal(fillError.name, "LlmFillRequestError");
  assert.equal(fillError.field, "maxRounds");
  assert.equal(fillError.value, 0);
  assert.ok(fillError instanceof Error);

  const loopError = new CodingLoopRequestError("taskCards", [], "必须为非空数组");
  assert.equal(loopError.name, "CodingLoopRequestError");
  assert.equal(loopError.field, "taskCards");
  assert.deepEqual(loopError.value, []);
  assert.ok(loopError instanceof Error);
});
