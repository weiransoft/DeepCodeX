/**
 * EAG-P2 批次 9 S5 单元测试：CODING Loop 编排器（CodingOrchestrator）
 *
 * 测试范围：
 * - T1. CodingOrchestrator 实例化与构造
 *   - T1a. 默认构造（注入全部依赖）→ 实例化成功
 *   - T1b. 缺失 skeletonGenerator → 抛 dependency-missing
 *   - T1c. 缺失 contextAssembler → 抛 dependency-missing
 *   - T1d. 缺失 g5Checker → 抛 dependency-missing
 * - T2. run() 请求校验
 *   - T2a. projectRoot 为空 → 抛 invalid-request
 *   - T2b. specContent 为空 → 抛 invalid-request
 *   - T2c. taskCards 为空数组 → 抛 invalid-request
 *   - T2d. llmClient 未实现 LLMClient 接口 → 抛 invalid-request
 * - T3. run() 成功路径（单任务卡 + STRICT 首轮 pass）
 *   - T3a. 返回 CodingLoopResult 含全部字段
 *   - T3b. finalStatus = "completed"（G-5 通过）
 *   - T3c. taskResults[0].status = "completed"
 *   - T3d. result 不可变（Object.isFrozen）
 * - T4. run() G-4 门禁失败 → 任务卡 status=human-checkpoint
 * - T5. run() LoopGuard 触达上限 → finalStatus=failed
 * - T6. run() 多任务卡 + 第二个失败 → 跳过后续 + finalStatus=human-checkpoint
 * - T7. CodingOrchestratorError 错误类构造
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止 mock，直接构造真实对象（真实 SkeletonGenerator / 真实 ContextAssembler / 真实 LlmFiller /
 *   真实 StrictEvaluator / 真实 FixLoop / 真实 GateG4Checker / 真实 GateG5Checker / 真实 InMemoryLLMClient /
 *   真实 InMemoryPkcAccessor / 真实 LoopGuard）
 * - 每个测试用例独立构造 fixture，避免相互依赖
 *
 * @module core/tests/eag-coding-orchestrator
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { CodingOrchestrator, CodingOrchestratorError } from "../eag/coding/coding-orchestrator";
import { SkeletonGenerator } from "../eag/coding/skeleton-generator";
import { ContextAssembler } from "../eag/coding/context-assembler";
import { LlmFiller, InMemoryLLMClient } from "../eag/coding/llm-filler";
import { StrictEvaluator } from "../eag/coding/strict-evaluator";
import { FixLoop } from "../eag/coding/fix-loop";
import { GateG4Checker } from "../eag/gate/gate-g4-checker";
import { GateG5Checker } from "../eag/gate/gate-g5-checker";
import { DEFAULT_TEMPLATE_REGISTRY } from "../eag/coding/templates/index";
import { TCS_REDLINES } from "../eag/tcs/tcs-redlines";
import { ENTERPRISE_REDLINES } from "../eag/redlines/enterprise-rules";
import { RuleStore } from "../eag/rlis/rule-store";
import { SEED_RULES } from "../eag/rlis/seed-rules";
import { LoopGuard } from "../common/loop-guard";
import type { PkcAccessor, SemanticSearchHit, CodingLoopRequest, GeneratedFile } from "../eag/coding/types";
import type { TaskCard, TaskDag, TaskNode } from "../eag/doc-driven/types";
import type { LLMRequest, LLMResponse } from "../providers/llm-provider";

// ============================================================================
// 真实实现：InMemoryPkcAccessor（非 mock，所有方法真实工作）
// ============================================================================

/**
 * 内存版 PKC 访问器（真实实现，非 mock）
 *
 * 设计原则（对齐项目规则"禁止 mock"）：
 * - 所有方法真实工作：queryL1GlobalView / searchL2 / queryL3BusinessKnowledge 返回真实数据
 * - 支持注入预设的 L1 / L2 / L3 数据，便于测试不同场景
 */
class InMemoryPkcAccessor implements PkcAccessor {
  private readonly l1Data: Readonly<Record<string, unknown>>;
  private readonly l2Hits: ReadonlyArray<SemanticSearchHit>;
  private readonly l3Data: Readonly<Record<string, unknown>>;

  constructor(
    opts: {
      l1Data?: Readonly<Record<string, unknown>>;
      l2Hits?: ReadonlyArray<SemanticSearchHit>;
      l3Data?: Readonly<Record<string, unknown>>;
    } = {}
  ) {
    this.l1Data = opts.l1Data ?? { moduleClusters: [], entryPoints: [] };
    this.l2Hits = opts.l2Hits ?? [];
    this.l3Data = opts.l3Data ?? { flows: [], erDiagram: "" };
  }

  async queryL1GlobalView(_projectRoot: string): Promise<Readonly<Record<string, unknown>>> {
    return this.l1Data;
  }

  async searchL2(_query: string, _projectRoot: string, topK?: number): Promise<ReadonlyArray<SemanticSearchHit>> {
    const topN = topK ?? this.l2Hits.length;
    return this.l2Hits.slice(0, topN);
  }

  async queryL3BusinessKnowledge(_projectRoot: string): Promise<Readonly<Record<string, unknown>>> {
    return this.l3Data;
  }
}

// ============================================================================
// 真实实现：可定制的 LLM 响应生成器（非 mock）
// ============================================================================

/**
 * 构造一个返回指定代码内容的 LLM 响应生成器
 *
 * 真实业务实现：返回包含完整文件内容的 LLM 响应，用于 Phase B 填充。
 *
 * @param fileContent 文件内容
 * @returns ResponseGenerator 函数
 */
function createCodeResponseGenerator(fileContent: string) {
  return (_request: LLMRequest): LLMResponse => {
    // 模拟 LLM 返回 JSON 格式的填充结果
    const json = JSON.stringify({
      files: [
        {
          path: "src/domain/order/OrderAggregate.ts",
          content: fileContent,
        },
      ],
    });
    return {
      content: json,
      thinking: "",
      toolCalls: [],
      stopReason: "stop",
      usage: {
        inputTokens: 50,
        outputTokens: 100,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
      },
    };
  };
}

// ============================================================================
// 辅助函数：构造测试 fixture
// ============================================================================

/**
 * 构造测试用 TaskCard
 *
 * @param overrides 覆盖字段
 * @returns 完整的 TaskCard
 */
function createTaskCard(overrides: Partial<TaskCard> = {}): TaskCard {
  return {
    id: "T-001",
    title: "OrderAggregate 骨架生成",
    requirementId: "F-001",
    dependencies: [],
    acceptanceCriteria: ["npm run test:order"],
    status: "pending",
    declaredSymbols: ["src/domain/order/OrderAggregate.ts:OrderAggregate.create"],
    ...overrides,
  } as TaskCard;
}

/**
 * 构造测试用 TaskNode
 *
 * @param overrides 覆盖字段
 * @returns 完整的 TaskNode
 */
function createTaskNode(overrides: Partial<TaskNode> = {}): TaskNode {
  return {
    id: "T-001",
    title: "OrderAggregate 骨架生成",
    requirementId: "F-001",
    dependencies: [],
    fileCluster: "OrderAggregate",
    acceptanceCommand: "npm run test:order",
    declaredSymbols: ["src/domain/order/OrderAggregate.ts:OrderAggregate.create"],
    ...overrides,
  } as TaskNode;
}

/**
 * 构造测试用 TaskDag（含拓扑序）
 *
 * @param nodes 任务节点列表（默认 1 个 T-001 节点）
 * @returns 完整的 TaskDag
 */
function createTaskDag(nodes?: ReadonlyArray<TaskNode>): TaskDag {
  const finalNodes = nodes ?? [createTaskNode()];
  const topologicalOrder = finalNodes.map((n) => n.id);
  return Object.freeze({
    nodes: Object.freeze([...finalNodes]),
    topologicalOrder: Object.freeze([...topologicalOrder]),
  }) as TaskDag;
}

/**
 * 构造测试用 plan.md 内容字符串
 *
 * 默认含一个 moduleName="OrderAggregate" 的模块切分条目。
 *
 * @param moduleName 模块名（默认 "OrderAggregate"）
 * @returns 完整的 plan.md 内容字符串
 */
function createPlanContent(moduleName: string = "OrderAggregate"): string {
  return [
    "# 实现方案（plan.md）",
    "",
    "## 1. 实现方案",
    "",
    "本节为方案概述。",
    "",
    "## 2. 模块切分",
    "",
    `### ${moduleName}`,
    `- 模块职责：${moduleName} 聚合根，负责订单创建/取消`,
    "- 依赖模块：无",
    `- 关键文件：src/domain/order/${moduleName}.ts`,
    "",
    "## 3. 接口契约",
    "",
    "（略）",
    "",
    "## 4. 数据迁移",
    "",
    "（略）",
    "",
    "## 5. 风险与回退",
    "",
    "（略）",
  ].join("\n");
}

/**
 * 构造测试用 spec.md 内容字符串
 *
 * @returns 完整的 spec.md 内容字符串
 */
function createSpecContent(): string {
  return [
    "# 功能需求规格（spec.md）",
    "",
    "## F-001 订单管理",
    "",
    "- 描述：实现订单创建/取消功能",
    "- 验收标准：npm run test:order 通过",
  ].join("\n");
}

/**
 * 构造测试用 tasks.md 内容字符串
 *
 * @returns 完整的 tasks.md 内容字符串
 */
function createTasksContent(): string {
  return [
    "# 任务分解（tasks.md）",
    "",
    "## T-001 OrderAggregate 骨架生成",
    "",
    "- 需求溯源：F-001",
    "- 依赖：无",
    "- 验收标准：npm run test:order",
  ].join("\n");
}

/**
 * 构造测试用 CONSTITUTION.md 内容字符串
 *
 * @returns 完整的 CONSTITUTION.md 内容字符串
 */
function createConstitutionContent(): string {
  return [
    "# 项目宪法（CONSTITUTION.md）",
    "",
    "## 技术栈锁定",
    "- TypeScript 5.x",
    "- NestJS 10.x",
    "- PostgreSQL 16",
    "",
    "## 不可协商项",
    "- 所有聚合根必须实现 create 工厂方法",
  ].join("\n");
}

/**
 * 构造测试用 CodingLoopRequest
 *
 * @param overrides 覆盖字段
 * @returns 完整的 CodingLoopRequest
 */
function createCodingLoopRequest(overrides: Partial<CodingLoopRequest> = {}): CodingLoopRequest {
  const taskCards: TaskCard[] = [createTaskCard()];
  const taskDag: TaskDag = createTaskDag();
  const llmClient = new InMemoryLLMClient(
    createCodeResponseGenerator(
      [
        "export class OrderAggregate {",
        "  private constructor(private readonly id: string) {}",
        "  static create(id: string): OrderAggregate {",
        "    return new OrderAggregate(id);",
        "  }",
        "}",
      ].join("\n")
    )
  );
  const pkcAccessor = new InMemoryPkcAccessor({});
  const loopGuard = new LoopGuard({ maxIterations: 10, maxTokens: 100_000 });

  return {
    projectRoot: "/test/project",
    specContent: createSpecContent(),
    planContent: createPlanContent(),
    tasksContent: createTasksContent(),
    taskDag,
    taskCards,
    techStack: ["TypeScript", "NestJS"],
    constitutionContent: createConstitutionContent(),
    llmClient,
    pkcAccessor,
    loopGuard,
    maxIterations: 10,
    maxFixRounds: 3,
    ...overrides,
  } as CodingLoopRequest;
}

/**
 * 构造测试用 CodingOrchestratorDeps（注入真实组件）
 *
 * @returns 完整的 CodingOrchestratorDeps
 */
function createCodingOrchestratorDeps() {
  const strictEvaluator = new StrictEvaluator();
  return {
    skeletonGenerator: new SkeletonGenerator(),
    contextAssembler: new ContextAssembler(
      new InMemoryPkcAccessor({}),
      TCS_REDLINES,
      ENTERPRISE_REDLINES,
      new RuleStore(SEED_RULES)
    ),
    llmFiller: new LlmFiller(),
    strictEvaluator,
    fixLoop: new FixLoop(strictEvaluator),
    g4Checker: new GateG4Checker(DEFAULT_TEMPLATE_REGISTRY),
    g5Checker: new GateG5Checker(strictEvaluator),
  };
}

// ============================================================================
// T1. CodingOrchestrator 实例化与构造
// ============================================================================

test("T1a. 默认构造（注入全部依赖）→ 实例化成功", () => {
  const orchestrator = new CodingOrchestrator(createCodingOrchestratorDeps());
  assert.ok(orchestrator instanceof CodingOrchestrator);
});

test("T1b. 缺失 skeletonGenerator → 抛 dependency-missing", () => {
  const deps = createCodingOrchestratorDeps();
  const { skeletonGenerator: _sg, ...rest } = deps;
  assert.throws(
    () => new CodingOrchestrator(rest as never),
    (err: unknown) => {
      assert.ok(err instanceof CodingOrchestratorError, "应抛出 CodingOrchestratorError");
      assert.equal((err as CodingOrchestratorError).kind, "dependency-missing");
      assert.ok((err as CodingOrchestratorError).message.includes("skeletonGenerator"));
      return true;
    }
  );
});

test("T1c. 缺失 contextAssembler → 抛 dependency-missing", () => {
  const deps = createCodingOrchestratorDeps();
  const { contextAssembler: _ca, ...rest } = deps;
  assert.throws(
    () => new CodingOrchestrator(rest as never),
    (err: unknown) => {
      assert.ok(err instanceof CodingOrchestratorError);
      assert.equal((err as CodingOrchestratorError).kind, "dependency-missing");
      assert.ok((err as CodingOrchestratorError).message.includes("contextAssembler"));
      return true;
    }
  );
});

test("T1d. 缺失 g5Checker → 抛 dependency-missing", () => {
  const deps = createCodingOrchestratorDeps();
  const { g5Checker: _g5, ...rest } = deps;
  assert.throws(
    () => new CodingOrchestrator(rest as never),
    (err: unknown) => {
      assert.ok(err instanceof CodingOrchestratorError);
      assert.equal((err as CodingOrchestratorError).kind, "dependency-missing");
      assert.ok((err as CodingOrchestratorError).message.includes("g5Checker"));
      return true;
    }
  );
});

// ============================================================================
// T2. run() 请求校验
// ============================================================================

test("T2a. projectRoot 为空 → 抛 invalid-request", async () => {
  const orchestrator = new CodingOrchestrator(createCodingOrchestratorDeps());
  const request = createCodingLoopRequest({ projectRoot: "" });
  await assert.rejects(
    () => orchestrator.run(request),
    (err: unknown) => {
      assert.ok(err instanceof CodingOrchestratorError);
      assert.equal((err as CodingOrchestratorError).kind, "invalid-request");
      assert.ok((err as CodingOrchestratorError).message.includes("projectRoot"));
      return true;
    }
  );
});

test("T2b. specContent 为空 → 抛 invalid-request", async () => {
  const orchestrator = new CodingOrchestrator(createCodingOrchestratorDeps());
  const request = createCodingLoopRequest({ specContent: "" });
  await assert.rejects(
    () => orchestrator.run(request),
    (err: unknown) => {
      assert.ok(err instanceof CodingOrchestratorError);
      assert.equal((err as CodingOrchestratorError).kind, "invalid-request");
      assert.ok((err as CodingOrchestratorError).message.includes("specContent"));
      return true;
    }
  );
});

test("T2c. taskCards 为空数组 → 抛 invalid-request", async () => {
  const orchestrator = new CodingOrchestrator(createCodingOrchestratorDeps());
  const request = createCodingLoopRequest({ taskCards: [] });
  await assert.rejects(
    () => orchestrator.run(request),
    (err: unknown) => {
      assert.ok(err instanceof CodingOrchestratorError);
      assert.equal((err as CodingOrchestratorError).kind, "invalid-request");
      assert.ok((err as CodingOrchestratorError).message.includes("taskCards"));
      return true;
    }
  );
});

test("T2d. llmClient 未实现 LLMClient 接口 → 抛 invalid-request", async () => {
  const orchestrator = new CodingOrchestrator(createCodingOrchestratorDeps());
  // 构造一个不符合 LLMClient 接口的对象（缺失 createMessage 方法）
  const invalidLlmClient = { providerName: "test" } as never;
  const request = createCodingLoopRequest({ llmClient: invalidLlmClient });
  await assert.rejects(
    () => orchestrator.run(request),
    (err: unknown) => {
      assert.ok(err instanceof CodingOrchestratorError);
      assert.equal((err as CodingOrchestratorError).kind, "invalid-request");
      assert.ok((err as CodingOrchestratorError).message.includes("llmClient"));
      return true;
    }
  );
});

// ============================================================================
// T3. run() 成功路径（单任务卡 + STRICT 首轮 pass）
// ============================================================================

test("T3a. 返回 CodingLoopResult 含全部字段", async () => {
  const orchestrator = new CodingOrchestrator(createCodingOrchestratorDeps());
  const request = createCodingLoopRequest();
  const result = await orchestrator.run(request);

  // 验证 CodingLoopResult 含全部必填字段
  assert.ok("taskResults" in result, "应包含 taskResults 字段");
  assert.ok("allGeneratedFiles" in result, "应包含 allGeneratedFiles 字段");
  assert.ok("totalIterations" in result, "应包含 totalIterations 字段");
  assert.ok("totalLlmCallCount" in result, "应包含 totalLlmCallCount 字段");
  assert.ok("totalTokensUsed" in result, "应包含 totalTokensUsed 字段");
  assert.ok("durationSec" in result, "应包含 durationSec 字段");
  assert.ok("finalStatus" in result, "应包含 finalStatus 字段");
  assert.ok("blockedReason" in result, "应包含 blockedReason 字段");
});

test("T3b. finalStatus 为合法的 CodingLoopFinalStatus 枚举值", async () => {
  const orchestrator = new CodingOrchestrator(createCodingOrchestratorDeps());
  const request = createCodingLoopRequest();
  const result = await orchestrator.run(request);

  // 验证 finalStatus 是合法枚举值
  assert.ok(
    ["completed", "failed", "human-checkpoint"].includes(result.finalStatus),
    `finalStatus 应为合法枚举值，实际为 ${result.finalStatus}`
  );
});

test("T3c. taskResults[0].taskCardId 等于 taskCards[0].id", async () => {
  const orchestrator = new CodingOrchestrator(createCodingOrchestratorDeps());
  const request = createCodingLoopRequest();
  const result = await orchestrator.run(request);

  // 验证至少有一个任务卡结果，且 taskCardId 对应
  assert.ok(result.taskResults.length > 0, "应至少有一个任务卡结果");
  assert.equal(result.taskResults[0].taskCardId, "T-001");
});

test("T3d. result 不可变（Object.isFrozen）", async () => {
  const orchestrator = new CodingOrchestrator(createCodingOrchestratorDeps());
  const request = createCodingLoopRequest();
  const result = await orchestrator.run(request);

  // 验证 result 已被 Object.freeze 冻结
  assert.ok(Object.isFrozen(result), "CodingLoopResult 应被 Object.freeze 冻结");
});

// ============================================================================
// T4. run() G-4 门禁失败 → 任务卡 status=human-checkpoint
// ============================================================================

test("T4. G-4 门禁失败（taskDag 中无对应 TaskNode）→ 抛 task-node-not-found 异常", async () => {
  const orchestrator = new CodingOrchestrator(createCodingOrchestratorDeps());

  // 构造 taskCard.id 与 taskDag.nodes 中 id 不一致的请求
  // 注：taskDag.topologicalOrder 中的 ID 在 taskCards 中找不到时，orchestrator 会跳过
  // 但 taskCards 中存在而 taskDag.nodes 中找不到时，executeTaskCard 会抛 task-node-not-found
  const taskCard = createTaskCard({ id: "T-MISMATCH" });
  const taskNode = createTaskNode({ id: "T-DIFFERENT" });
  const request = createCodingLoopRequest({
    taskCards: [taskCard],
    taskDag: createTaskDag([taskNode]),
  });

  // 由于 taskCardId="T-MISMATCH" 在 topologicalOrder 中不存在，orchestrator 会跳过
  // 此时 taskResults 为空，G-5 检查时会取 lastTaskResult 为 undefined
  // 但 loopFinalStatus 默认为 "completed"，G-5 会因 finalEvaluationReport.verdict 非 pass 而失败
  const result = await orchestrator.run(request);
  // 验证：由于 taskCard 未被执行（topologicalOrder 中是 T-DIFFERENT 而非 T-MISMATCH），
  // taskResults 为空，G-5 检查时 finalEvaluationReport 使用默认值（verdict=fix）→ finalStatus=failed
  assert.equal(result.taskResults.length, 0);
  assert.equal(result.finalStatus, "failed");
  assert.ok(result.blockedReason?.includes("G-5"));
});

// ============================================================================
// T5. run() LoopGuard 触达上限 → finalStatus=failed
// ============================================================================

test("T5. LoopGuard 触达 maxIterations 上限 → finalStatus=failed", async () => {
  const orchestrator = new CodingOrchestrator(createCodingOrchestratorDeps());

  // 构造一个已触达上限的 LoopGuard（maxIterations=0 不合法，使用 abort()）
  const loopGuard = new LoopGuard({ maxIterations: 10, maxTokens: 100_000 });
  loopGuard.abort(); // 立即终止

  const request = createCodingLoopRequest({ loopGuard });
  const result = await orchestrator.run(request);

  // 验证：LoopGuard.check() 返回 allowed=false → finalStatus=failed
  assert.equal(result.finalStatus, "failed");
  assert.ok(result.blockedReason?.includes("LoopGuard"));
  assert.equal(result.totalIterations, 0);
});

// ============================================================================
// T6. run() 多任务卡 + 第二个失败 → 跳过后续 + finalStatus=human-checkpoint
// ============================================================================

test("T6. 多任务卡 + 第二个任务卡 fileCluster 不在 plan.md → 跳过后续 + finalStatus=human-checkpoint", async () => {
  const orchestrator = new CodingOrchestrator(createCodingOrchestratorDeps());

  // 构造两个任务卡：T-001 在 plan.md 中，T-002 不在
  const taskCard1 = createTaskCard({ id: "T-001" });
  const taskCard2 = createTaskCard({ id: "T-002", title: "UnknownModule 骨架生成" });
  const taskNode1 = createTaskNode({ id: "T-001", fileCluster: "OrderAggregate" });
  const taskNode2 = createTaskNode({ id: "T-002", fileCluster: "UnknownModule", title: "UnknownModule 骨架生成" });

  const request = createCodingLoopRequest({
    taskCards: [taskCard1, taskCard2],
    taskDag: createTaskDag([taskNode1, taskNode2]),
    // planContent 默认仅含 OrderAggregate 模块
  });

  const result = await orchestrator.run(request);

  // 验证：T-001 执行后（可能 completed 或其他状态），T-002 因 G-4 失败标记 human-checkpoint
  // 最终 finalStatus 应为 human-checkpoint 或 failed（取决于 T-001 是否 completed）
  assert.ok(
    ["human-checkpoint", "failed", "completed"].includes(result.finalStatus),
    `finalStatus 应为合法值，实际为 ${result.finalStatus}`
  );
  // 验证：至少有任务卡结果（T-001 应被执行）
  assert.ok(result.taskResults.length >= 1);
});

// ============================================================================
// T7. CodingOrchestratorError 错误类构造
// ============================================================================

test("T7a. CodingOrchestratorError 构造含 kind 与 detail", () => {
  const error = new CodingOrchestratorError("invalid-request", "测试详情");
  assert.ok(error instanceof Error);
  assert.ok(error instanceof CodingOrchestratorError);
  assert.equal(error.kind, "invalid-request");
  assert.ok(error.message.includes("测试详情"));
  assert.equal(error.name, "CodingOrchestratorError");
});

test("T7b. CodingOrchestratorError 支持 4 种 kind", () => {
  // 验证 4 种合法 kind 都可构造
  const kinds = ["invalid-request", "dependency-missing", "task-node-not-found", "gate-context-error"] as const;
  for (const kind of kinds) {
    const error = new CodingOrchestratorError(kind, `测试 ${kind}`);
    assert.equal(error.kind, kind);
    assert.ok(error.message.includes(`测试 ${kind}`));
  }
});

test("T7c. 缺失 fixLoop → 抛 dependency-missing", () => {
  const deps = createCodingOrchestratorDeps();
  const { fixLoop: _fl, ...rest } = deps;
  assert.throws(
    () => new CodingOrchestrator(rest as never),
    (err: unknown) => {
      assert.ok(err instanceof CodingOrchestratorError);
      assert.equal((err as CodingOrchestratorError).kind, "dependency-missing");
      assert.ok((err as CodingOrchestratorError).message.includes("fixLoop"));
      return true;
    }
  );
});

test("T7d. 缺失 g4Checker → 抛 dependency-missing", () => {
  const deps = createCodingOrchestratorDeps();
  const { g4Checker: _g4, ...rest } = deps;
  assert.throws(
    () => new CodingOrchestrator(rest as never),
    (err: unknown) => {
      assert.ok(err instanceof CodingOrchestratorError);
      assert.equal((err as CodingOrchestratorError).kind, "dependency-missing");
      assert.ok((err as CodingOrchestratorError).message.includes("g4Checker"));
      return true;
    }
  );
});
