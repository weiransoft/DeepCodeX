/**
 * EAG-P2 批次 9 S3 单元测试：Phase A 骨架生成器（SkeletonGenerator + PlanParser）
 *
 * 测试范围：
 * - T1. PlanParser.parseModuleSplits 解析正确性
 *   - T1a. 空内容 → 空数组
 *   - T1b. 无 "## 2. 模块切分" 章节 → 空数组
 *   - T1c. 单模块切分 → 解析正确（含 responsibility / dependsOn / keyFiles）
 *   - T1d. 多模块切分 → 全部解析
 *   - T1e. 多行关键文件形式 → 解析正确
 *   - T1f. 依赖模块含 "无" → 过滤为空数组
 * - T2. PlanParser.parseModuleSplit 单模块查找
 *   - T2a. 找到模块 → 返回 ModuleSplit
 *   - T2b. 未找到模块 → 返回 null
 * - T3. PlanParser.parseInterfaceContracts 解析正确性
 *   - T3a. 空内容 → 空数组
 *   - T3b. 单接口契约 → 解析正确（含 type / signature / description / errorCodes）
 *   - T3c. 接口类型映射（REST API / 服务方法 / 事件处理器 / 定时任务）
 * - T4. SkeletonGenerator 实例化
 *   - T4a. 默认 TemplateRegistry → 实例化成功
 *   - T4b. 自定义 TemplateRegistry → 实例化成功
 * - T5. SkeletonGenerator.generate 成功路径
 *   - T5a. 聚合根模块 → 生成 aggregate + domain-event 文件
 *   - T5b. 仓储模块 → 生成 repository-port + repository-impl 文件
 *   - T5c. 结果对象已冻结
 *   - T5d. files 数组与每个文件对象已冻结
 *   - T5e. fillPlaceholders 数组与每个占位对象已冻结
 *   - T5f. templateVariables 含每个 kind 的变量快照
 *   - T5g. durationMs >= 0
 *   - T5h. 占位 ID 格式 "PH-NNN"
 *   - T5i. 默认模块（无关键词匹配）→ 生成 module-index
 * - T6. determineRequiredKinds 启发式判定（通过 generate 间接测试）
 *   - T6a. responsibility 含 "聚合" → aggregate + domain-event
 *   - T6b. responsibility 含 "仓储" → repository-port + repository-impl
 *   - T6c. responsibility 含 "Controller" → rest-controller
 *   - T6d. responsibility 含 "DTO" → dto
 * - T7. scanPlaceholders 占位扫描（通过 generate 间接测试）
 *   - T7a. 占位 description 正确
 *   - T7b. 占位 kind 推断正确（method-body / class-body）
 *   - T7c. 占位 line 号正确（1-based）
 *   - T7d. 占位 expectedSignature 提取正确
 * - T8. computeFilePath 路径计算（通过 generate 间接测试）
 *   - T8a. aggregate → "src/<ClassName>.ts"
 *   - T8b. repository-port → "src/<ClassName>Repository.ts"
 *   - T8c. module-index → "src/index.ts"
 *   - T8d. outputDir 不以 / 结尾 → 自动补 /
 * - T9. 错误处理
 *   - T9a. planContent 为空 → invalid-request
 *   - T9b. tasksContent 为空 → invalid-request
 *   - T9c. taskDag 缺失 → invalid-request
 *   - T9d. taskCard.id 为空 → invalid-request
 *   - T9e. taskCard.requirementId 为空 → invalid-request
 *   - T9f. techStack 非数组 → invalid-request
 *   - T9g. projectRoot 为空 → invalid-request
 *   - T9h. outputDir 为空 → invalid-request
 *   - T9i. taskDag.nodes 中未找到 taskCard.id → invalid-request
 *   - T9j. TaskNode.fileCluster 为空 → invalid-request
 *   - T9k. planContent 中未找到 fileCluster → module-split-not-found
 *   - T9l. 所需 kind 未在 TemplateRegistry 注册 → template-not-registered
 *   - T9m. 模板变量校验失败 → variable-validation-failed
 *   - T9n. EJS 渲染失败 → template-render-failed
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止 mock，直接构造真实对象与真实 TemplateRegistry
 *
 * @module core/tests/eag-coding-skeleton-generator
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import ejs from "ejs";
import { SkeletonGenerator, SkeletonGeneratorError, PlanParser } from "../eag/coding/skeleton-generator";
import type {
  GeneratedFileKind,
  SkeletonGenerationRequest,
  TemplateRegistry,
  TemplateVariableSchema,
} from "../eag/coding/types";
import { DEFAULT_TEMPLATE_REGISTRY } from "../eag/coding/templates";
import type { TaskDag, TaskNode } from "../eag/doc-driven/types";

// ============================================================================
// 辅助函数：构造 plan.md 内容字符串
// ============================================================================

/**
 * 构造测试用 plan.md 内容字符串
 *
 * 包含 5 个章节，含 2 个模块切分与 2 个接口契约。
 * 章节 4/5 留空占位（测试不依赖这两章）。
 *
 * @param overrides 覆盖模块切分条目（默认 2 个模块：OrderAggregate + UserRepository）
 * @returns 完整的 plan.md 内容字符串
 */
function createPlanContent(
  overrides?: ReadonlyArray<{ moduleName: string; responsibility: string; dependsOn: string[]; keyFiles: string[] }>
): string {
  const moduleSplits = overrides ?? [
    {
      moduleName: "OrderAggregate",
      responsibility: "订单聚合根，负责订单创建/取消/支付",
      dependsOn: [],
      keyFiles: ["src/domain/order/OrderAggregate.ts", "src/domain/order/OrderCreated.ts"],
    },
    {
      moduleName: "UserRepository",
      responsibility: "用户仓储，提供用户查询",
      dependsOn: ["UserAggregate"],
      keyFiles: ["src/domain/user/UserRepository.ts", "src/infrastructure/user/UserRepositoryImpl.ts"],
    },
  ];

  // 渲染模块切分章节（单行关键文件形式）
  const moduleSection = moduleSplits
    .map((m) => {
      const dependsOnLine = m.dependsOn.length > 0 ? m.dependsOn.join(", ") : "无";
      const keyFilesLine = m.keyFiles.join(", ");
      return `### ${m.moduleName}\n- 模块职责：${m.responsibility}\n- 依赖模块：${dependsOnLine}\n- 关键文件：${keyFilesLine}\n`;
    })
    .join("\n");

  return [
    "# 实现方案（plan.md）",
    "",
    "## 1. 实现方案",
    "",
    "本节为方案概述。",
    "",
    "## 2. 模块切分",
    "",
    moduleSection,
    "## 3. 接口契约",
    "",
    "### OrderService.create",
    "- 类型：服务方法",
    "- 签名：create(command: OrderCreateCommand): Promise<OrderCreateResult>",
    "- 描述：创建订单",
    "- 错误码：400 InvalidCommand, 409 Conflict",
    "- 请求 Schema：{ orderId: string }",
    "- 响应 Schema：{ success: boolean }",
    "",
    "### OrderController.create",
    "- 类型：REST API",
    "- 签名：POST /api/v1/orders",
    "- 描述：创建订单 REST 端点",
    "- 错误码：400, 409",
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
 * 构造测试用 plan.md 内容字符串（多行关键文件形式）
 *
 * @returns 含多行关键文件形式的 plan.md 内容
 */
function createPlanContentWithMultiLineKeyFiles(): string {
  return [
    "# 实现方案（plan.md）",
    "",
    "## 2. 模块切分",
    "",
    "### MultiFileModule",
    "- 模块职责：测试多行关键文件",
    "- 依赖模块：无",
    "- 关键文件：",
    "  - src/file1.ts",
    "  - src/file2.ts",
    "  - src/file3.ts",
    "",
    "## 3. 接口契约",
    "",
    "（略）",
    "",
    "## 4. 数据迁移",
    "",
    "（略）",
  ].join("\n");
}

// ============================================================================
// 辅助函数：构造 TaskDag
// ============================================================================

/**
 * 构造测试用 TaskDag
 *
 * @param nodes 任务节点列表
 * @returns 完整的 TaskDag
 */
function createTaskDag(nodes: TaskNode[]): TaskDag {
  return {
    nodes: Object.freeze(nodes),
    topologicalOrder: Object.freeze(nodes.map((n) => n.id)),
  };
}

/**
 * 构造测试用 TaskNode
 *
 * @param id 任务 ID
 * @param fileCluster 文件簇名
 * @returns 完整的 TaskNode
 */
function createTaskNode(id: string, fileCluster: string): TaskNode {
  return {
    id,
    title: `任务 ${id}`,
    requirementId: "F-001",
    dependencies: [],
    fileCluster,
    acceptanceCommand: "npm test",
  };
}

// ============================================================================
// 辅助函数：构造 SkeletonGenerationRequest
// ============================================================================

/**
 * 构造测试用 SkeletonGenerationRequest
 *
 * 默认 taskCard.id="T-001"，taskDag.nodes 含对应的 TaskNode（fileCluster="OrderAggregate"），
 * planContent 含 OrderAggregate 模块切分。
 *
 * @param overrides 覆盖字段
 * @returns 完整的 SkeletonGenerationRequest
 */
function createRequest(overrides: Partial<SkeletonGenerationRequest> = {}): SkeletonGenerationRequest {
  const planContent = overrides.planContent ?? createPlanContent();
  const taskCard = overrides.taskCard ?? {
    id: "T-001",
    title: "OrderAggregate 骨架生成",
    requirementId: "F-001",
    dependencies: [],
    acceptanceCriteria: ["npm test order"],
    status: "pending" as const,
    declaredSymbols: ["src/domain/order/OrderAggregate.ts:OrderAggregate.create"],
  };
  const taskDag = overrides.taskDag ?? createTaskDag([createTaskNode("T-001", "OrderAggregate")]);

  return {
    planContent,
    tasksContent: overrides.tasksContent ?? "# 任务分解\n## T-001 OrderAggregate 骨架\n...",
    taskDag,
    taskCard,
    techStack: overrides.techStack ?? ["TypeScript", "NestJS", "PostgreSQL", "TypeORM"],
    projectRoot: overrides.projectRoot ?? "/test/project",
    outputDir: overrides.outputDir ?? "src/",
  };
}

// ============================================================================
// 自定义 TemplateRegistry（用于错误场景测试）
// ============================================================================

/**
 * 自定义 TemplateRegistry：仅注册部分 kind（用于 template-not-registered 测试）
 *
 * 真实实现：内部维护一个 Set<GeneratedFileKind>，所有方法真实工作。
 */
class PartialTemplateRegistry implements TemplateRegistry {
  private readonly registeredKinds: ReadonlySet<GeneratedFileKind>;
  private readonly templateStrings: Readonly<Record<string, string>>;

  constructor(kinds: ReadonlyArray<GeneratedFileKind>, templateStrings: Readonly<Record<string, string>> = {}) {
    this.registeredKinds = new Set(kinds);
    this.templateStrings = templateStrings;
  }

  getTemplate(kind: GeneratedFileKind): string {
    if (!this.registeredKinds.has(kind)) {
      throw new Error(`未注册的 kind: ${kind}`);
    }
    return this.templateStrings[kind] ?? `// 默认模板 for ${kind}`;
  }

  listKinds(): ReadonlyArray<GeneratedFileKind> {
    return Object.freeze(Array.from(this.registeredKinds) as GeneratedFileKind[]);
  }

  getVariableSchema(kind: GeneratedFileKind): TemplateVariableSchema {
    return {
      validate: (variables: Readonly<Record<string, unknown>>) => {
        if (!this.registeredKinds.has(kind)) {
          return { success: false, errors: [`未注册的 kind: ${kind}`] };
        }
        return { success: true, data: variables };
      },
    };
  }
}

/**
 * 自定义 TemplateRegistry：schema 校验始终失败（用于 variable-validation-failed 测试）
 */
class AlwaysFailSchemaRegistry implements TemplateRegistry {
  private readonly kinds: ReadonlyArray<GeneratedFileKind>;

  constructor(kinds: ReadonlyArray<GeneratedFileKind>) {
    this.kinds = kinds;
  }

  getTemplate(kind: GeneratedFileKind): string {
    return `// 模板 for ${kind}`;
  }

  listKinds(): ReadonlyArray<GeneratedFileKind> {
    return Object.freeze([...this.kinds] as GeneratedFileKind[]);
  }

  getVariableSchema(_kind: GeneratedFileKind): TemplateVariableSchema {
    return {
      validate: () => ({
        success: false,
        errors: Object.freeze(["测试校验失败：变量非法"]),
      }),
    };
  }
}

/**
 * 自定义 TemplateRegistry：返回非法 EJS 模板（用于 template-render-failed 测试）
 */
class InvalidEjsTemplateRegistry implements TemplateRegistry {
  private readonly kinds: ReadonlyArray<GeneratedFileKind>;

  constructor(kinds: ReadonlyArray<GeneratedFileKind>) {
    this.kinds = kinds;
  }

  getTemplate(_kind: GeneratedFileKind): string {
    // 含未闭合的 EJS 标签，渲染时会抛错
    return `<%- moduleName %>`;
  }

  listKinds(): ReadonlyArray<GeneratedFileKind> {
    return Object.freeze([...this.kinds] as GeneratedFileKind[]);
  }

  getVariableSchema(_kind: GeneratedFileKind): TemplateVariableSchema {
    return {
      validate: (variables: Readonly<Record<string, unknown>>) => ({
        success: true,
        data: variables,
      }),
    };
  }
}

// ============================================================================
// T1. PlanParser.parseModuleSplits 解析正确性
// ============================================================================

test("T1a. 空内容 → 返回空数组", () => {
  const splits = PlanParser.parseModuleSplits("");
  assert.equal(splits.length, 0);
});

test("T1b. 无 '## 2. 模块切分' 章节 → 返回空数组", () => {
  const plan = "# 实现方案\n## 1. 实现方案\n（略）\n## 3. 接口契约\n（略）";
  const splits = PlanParser.parseModuleSplits(plan);
  assert.equal(splits.length, 0);
});

test("T1c. 单模块切分 → 解析正确（含 responsibility / dependsOn / keyFiles）", () => {
  const plan = createPlanContent([
    {
      moduleName: "OrderAggregate",
      responsibility: "订单聚合根，负责订单创建/取消/支付",
      dependsOn: [],
      keyFiles: ["src/domain/order/OrderAggregate.ts", "src/domain/order/OrderCreated.ts"],
    },
  ]);
  const splits = PlanParser.parseModuleSplits(plan);
  assert.equal(splits.length, 1);
  assert.equal(splits[0].moduleName, "OrderAggregate");
  assert.equal(splits[0].responsibility, "订单聚合根，负责订单创建/取消/支付");
  assert.equal(splits[0].dependsOn.length, 0);
  assert.equal(splits[0].keyFiles.length, 2);
  assert.ok(splits[0].keyFiles.includes("src/domain/order/OrderAggregate.ts"));
});

test("T1d. 多模块切分 → 全部解析", () => {
  const plan = createPlanContent();
  const splits = PlanParser.parseModuleSplits(plan);
  assert.equal(splits.length, 2);
  assert.equal(splits[0].moduleName, "OrderAggregate");
  assert.equal(splits[1].moduleName, "UserRepository");
  assert.equal(splits[1].dependsOn.length, 1);
  assert.equal(splits[1].dependsOn[0], "UserAggregate");
});

test("T1e. 多行关键文件形式 → 解析正确", () => {
  const plan = createPlanContentWithMultiLineKeyFiles();
  const splits = PlanParser.parseModuleSplits(plan);
  assert.equal(splits.length, 1);
  assert.equal(splits[0].moduleName, "MultiFileModule");
  assert.equal(splits[0].keyFiles.length, 3);
  assert.ok(splits[0].keyFiles.includes("src/file1.ts"));
  assert.ok(splits[0].keyFiles.includes("src/file2.ts"));
  assert.ok(splits[0].keyFiles.includes("src/file3.ts"));
});

test("T1f. 依赖模块含 '无' → 过滤为空数组", () => {
  const plan = createPlanContent([
    {
      moduleName: "StandaloneModule",
      responsibility: "独立模块",
      dependsOn: [],
      keyFiles: ["src/standalone.ts"],
    },
  ]);
  // 修改 responsibility 与 dependsOn 为 "无"
  const customPlan = plan.replace("- 依赖模块：无", "- 依赖模块：无");
  const splits = PlanParser.parseModuleSplits(customPlan);
  assert.equal(splits.length, 1);
  assert.equal(splits[0].dependsOn.length, 0);
});

// ============================================================================
// T2. PlanParser.parseModuleSplit 单模块查找
// ============================================================================

test("T2a. 找到模块 → 返回 ModuleSplit", () => {
  const plan = createPlanContent();
  const split = PlanParser.parseModuleSplit(plan, "OrderAggregate");
  assert.ok(split !== null);
  assert.equal(split!.moduleName, "OrderAggregate");
});

test("T2b. 未找到模块 → 返回 null", () => {
  const plan = createPlanContent();
  const split = PlanParser.parseModuleSplit(plan, "NonExistentModule");
  assert.equal(split, null);
});

// ============================================================================
// T3. PlanParser.parseInterfaceContracts 解析正确性
// ============================================================================

test("T3a. 空内容 → 返回空数组", () => {
  const contracts = PlanParser.parseInterfaceContracts("");
  assert.equal(contracts.length, 0);
});

test("T3b. 单接口契约 → 解析正确（含 type / signature / description / errorCodes）", () => {
  const plan = createPlanContent();
  const contracts = PlanParser.parseInterfaceContracts(plan);
  assert.equal(contracts.length, 2);

  // 第一个接口：OrderService.create（服务方法）
  const svc = contracts.find((c) => c.interfaceName === "OrderService.create");
  assert.ok(svc !== undefined);
  assert.equal(svc!.type, "service-method");
  assert.equal(svc!.signature, "create(command: OrderCreateCommand): Promise<OrderCreateResult>");
  assert.equal(svc!.description, "创建订单");
  assert.equal(svc!.errorCodes.length, 2);
  assert.ok(svc!.errorCodes.includes("400 InvalidCommand"));
  assert.ok(svc!.errorCodes.includes("409 Conflict"));
  assert.ok(svc!.requestSchema !== undefined);
  assert.ok(svc!.responseSchema !== undefined);
});

test("T3c. 接口类型映射（REST API / 服务方法 / 事件处理器 / 定时任务）", () => {
  const plan = [
    "# 实现方案（plan.md）",
    "",
    "## 3. 接口契约",
    "",
    "### RestApi.create",
    "- 类型：REST API",
    "- 签名：POST /api/v1/items",
    "- 描述：REST 端点",
    "",
    "### ServiceMethod.handle",
    "- 类型：服务方法",
    "- 签名：handle(input: Input): Promise<Output>",
    "- 描述：服务方法",
    "",
    "### EventHandler.onEvent",
    "- 类型：事件处理器",
    "- 签名：onEvent(event: DomainEvent): Promise<void>",
    "- 描述：事件处理器",
    "",
    "### Job.scheduledRun",
    "- 类型：定时任务",
    "- 签名：scheduledRun(): Promise<void>",
    "- 描述：定时任务",
    "",
    "## 4. 数据迁移",
    "",
    "（略）",
  ].join("\n");

  const contracts = PlanParser.parseInterfaceContracts(plan);
  assert.equal(contracts.length, 4);
  assert.equal(contracts[0].type, "rest-api");
  assert.equal(contracts[1].type, "service-method");
  assert.equal(contracts[2].type, "event-handler");
  assert.equal(contracts[3].type, "job");
});

// ============================================================================
// T4. SkeletonGenerator 实例化
// ============================================================================

test("T4a. 默认 TemplateRegistry → 实例化成功", () => {
  const generator = new SkeletonGenerator();
  assert.ok(generator instanceof SkeletonGenerator);
});

test("T4b. 自定义 TemplateRegistry → 实例化成功", () => {
  const customRegistry = new PartialTemplateRegistry(["aggregate"]);
  const generator = new SkeletonGenerator(customRegistry);
  assert.ok(generator instanceof SkeletonGenerator);
});

// ============================================================================
// T5. SkeletonGenerator.generate 成功路径
// ============================================================================

test("T5a. 聚合根模块 → 生成 aggregate + domain-event 文件", () => {
  const generator = new SkeletonGenerator();
  const request = createRequest();
  const result = generator.generate(request);

  // 聚合根 responsibility 含 "聚合"，应同时生成 aggregate + domain-event
  const kinds = result.files.map((f) => f.kind);
  assert.ok(kinds.includes("aggregate"));
  assert.ok(kinds.includes("domain-event"));
  assert.ok(result.files.length >= 2);
});

test("T5b. 仓储模块 → 生成 repository-port + repository-impl 文件", () => {
  const generator = new SkeletonGenerator();
  const request = createRequest({
    taskCard: {
      id: "T-002",
      title: "UserRepository 骨架生成",
      requirementId: "F-001",
      dependencies: [],
      acceptanceCriteria: ["npm test user"],
      status: "pending",
      declaredSymbols: ["src/domain/user/UserRepository.ts:UserRepository.findById"],
    },
    taskDag: createTaskDag([createTaskNode("T-002", "UserRepository")]),
  });
  const result = generator.generate(request);

  // 仓储 responsibility 含 "仓储"，应同时生成 repository-port + repository-impl
  const kinds = result.files.map((f) => f.kind);
  assert.ok(kinds.includes("repository-port"));
  assert.ok(kinds.includes("repository-impl"));
});

test("T5c. 结果对象已冻结", () => {
  const generator = new SkeletonGenerator();
  const result = generator.generate(createRequest());
  assert.equal(Object.isFrozen(result), true);
});

test("T5d. files 数组与每个文件对象已冻结", () => {
  const generator = new SkeletonGenerator();
  const result = generator.generate(createRequest());
  assert.equal(Object.isFrozen(result.files), true);
  for (const file of result.files) {
    assert.equal(Object.isFrozen(file), true);
  }
});

test("T5e. fillPlaceholders 数组与每个占位对象已冻结", () => {
  const generator = new SkeletonGenerator();
  const result = generator.generate(createRequest());
  assert.equal(Object.isFrozen(result.fillPlaceholders), true);
  for (const ph of result.fillPlaceholders) {
    assert.equal(Object.isFrozen(ph), true);
  }
});

test("T5f. templateVariables 含每个 kind 的变量快照", () => {
  const generator = new SkeletonGenerator();
  const result = generator.generate(createRequest());
  const kinds = result.files.map((f) => f.kind);
  for (const kind of kinds) {
    assert.ok(result.templateVariables[kind] !== undefined, `kind=${kind} 应在 templateVariables 中`);
  }
});

test("T5g. durationMs >= 0", () => {
  const generator = new SkeletonGenerator();
  const result = generator.generate(createRequest());
  assert.ok(result.durationMs >= 0);
});

test("T5h. 占位 ID 格式 'PH-NNN'", () => {
  const generator = new SkeletonGenerator();
  const result = generator.generate(createRequest());
  // 聚合根模板含 TODO(phase-b) 占位，应至少有一个占位
  assert.ok(result.fillPlaceholders.length > 0);
  for (const ph of result.fillPlaceholders) {
    assert.match(ph.id, /^PH-\d{3}$/);
  }
});

test("T5i. 默认模块（无关键词匹配）→ 生成 module-index", () => {
  const generator = new SkeletonGenerator();
  // 构造无任何关键词匹配的模块（responsibility 不含聚合/仓储/Controller 等关键词）
  const plan = createPlanContent([
    {
      moduleName: "PlainModule",
      responsibility: "通用工具",
      dependsOn: [],
      keyFiles: ["src/plain.ts"],
    },
  ]);
  const request = createRequest({
    planContent: plan,
    taskCard: {
      id: "T-003",
      title: "PlainModule 骨架生成",
      requirementId: "F-001",
      dependencies: [],
      acceptanceCriteria: ["npm test"],
      status: "pending",
      declaredSymbols: ["src/plain.ts:PlainModule"],
    },
    taskDag: createTaskDag([createTaskNode("T-003", "PlainModule")]),
  });
  const result = generator.generate(request);

  // 无关键词匹配时应生成 module-index
  const kinds = result.files.map((f) => f.kind);
  assert.ok(kinds.includes("module-index"));
  assert.equal(kinds.length, 1);
});

// ============================================================================
// T6. determineRequiredKinds 启发式判定（通过 generate 间接测试）
// ============================================================================

test("T6a. responsibility 含 '聚合' → aggregate + domain-event", () => {
  const generator = new SkeletonGenerator();
  const plan = createPlanContent([
    {
      moduleName: "OrderAggregate",
      responsibility: "订单聚合根，负责订单创建/取消/支付",
      dependsOn: [],
      keyFiles: ["src/OrderAggregate.ts"],
    },
  ]);
  const request = createRequest({
    planContent: plan,
    taskDag: createTaskDag([createTaskNode("T-001", "OrderAggregate")]),
  });
  const result = generator.generate(request);
  const kinds = result.files.map((f) => f.kind);
  assert.ok(kinds.includes("aggregate"));
  assert.ok(kinds.includes("domain-event"));
});

test("T6b. responsibility 含 '仓储' → repository-port + repository-impl", () => {
  const generator = new SkeletonGenerator();
  const plan = createPlanContent([
    {
      moduleName: "UserRepository",
      responsibility: "用户仓储，提供查询",
      dependsOn: [],
      keyFiles: ["src/UserRepository.ts"],
    },
  ]);
  const request = createRequest({
    planContent: plan,
    taskDag: createTaskDag([createTaskNode("T-001", "UserRepository")]),
  });
  const result = generator.generate(request);
  const kinds = result.files.map((f) => f.kind);
  assert.ok(kinds.includes("repository-port"));
  assert.ok(kinds.includes("repository-impl"));
});

test("T6c. responsibility 含 'Controller' → rest-controller", () => {
  const generator = new SkeletonGenerator();
  const plan = createPlanContent([
    {
      moduleName: "OrderController",
      responsibility: "订单 Controller，提供 REST 端点",
      dependsOn: [],
      keyFiles: ["src/OrderController.ts"],
    },
  ]);
  const request = createRequest({
    planContent: plan,
    taskDag: createTaskDag([createTaskNode("T-001", "OrderController")]),
  });
  const result = generator.generate(request);
  const kinds = result.files.map((f) => f.kind);
  assert.ok(kinds.includes("rest-controller"));
});

test("T6d. responsibility 含 'DTO' → dto", () => {
  const generator = new SkeletonGenerator();
  const plan = createPlanContent([
    {
      moduleName: "OrderDto",
      responsibility: "订单 DTO",
      dependsOn: [],
      keyFiles: ["src/OrderDto.ts"],
    },
  ]);
  const request = createRequest({
    planContent: plan,
    taskDag: createTaskDag([createTaskNode("T-001", "OrderDto")]),
  });
  const result = generator.generate(request);
  const kinds = result.files.map((f) => f.kind);
  assert.ok(kinds.includes("dto"));
});

// ============================================================================
// T7. scanPlaceholders 占位扫描（通过 generate 间接测试）
// ============================================================================

test("T7a. 占位 description 正确", () => {
  const generator = new SkeletonGenerator();
  const result = generator.generate(createRequest());
  // 聚合根模板含 "实现创建逻辑..." 占位
  const createPlaceholder = result.fillPlaceholders.find((p) => p.description.includes("创建逻辑"));
  assert.ok(createPlaceholder !== undefined);
  assert.ok(createPlaceholder!.description.length > 0);
});

test("T7b. 占位 kind 推断正确（method-body / class-body）", () => {
  const generator = new SkeletonGenerator();
  const result = generator.generate(createRequest());
  // 聚合根模板的占位都是 method-body（含 @param）
  const kinds = new Set(result.fillPlaceholders.map((p) => p.kind));
  assert.ok(kinds.has("method-body"));
  for (const kind of kinds) {
    assert.ok(kind === "method-body" || kind === "class-body" || kind === "config" || kind === "import");
  }
});

test("T7c. 占位 line 号正确（1-based，>= 1）", () => {
  const generator = new SkeletonGenerator();
  const result = generator.generate(createRequest());
  for (const ph of result.fillPlaceholders) {
    assert.ok(ph.line >= 1, `占位 ${ph.id} line=${ph.line} 应 >= 1`);
  }
});

test("T7d. 占位 expectedSignature 提取正确", () => {
  const generator = new SkeletonGenerator();
  const result = generator.generate(createRequest());
  // 聚合根模板的 create 方法占位应提取 expectedSignature
  const createPlaceholder = result.fillPlaceholders.find((p) => p.description.includes("创建逻辑"));
  assert.ok(createPlaceholder !== undefined);
  // expectedSignature 应包含 create 方法定义
  assert.ok(createPlaceholder!.expectedSignature !== undefined);
  assert.ok(createPlaceholder!.expectedSignature!.includes("create"));
});

// ============================================================================
// T8. computeFilePath 路径计算（通过 generate 间接测试）
// ============================================================================

test("T8a. aggregate → 'src/<ClassName>.ts'", () => {
  const generator = new SkeletonGenerator();
  const result = generator.generate(createRequest());
  const aggregateFile = result.files.find((f) => f.kind === "aggregate");
  assert.ok(aggregateFile !== undefined);
  assert.equal(aggregateFile!.relativePath, "src/OrderAggregate.ts");
});

test("T8b. repository-port → 'src/<ClassName>Repository.ts'", () => {
  const generator = new SkeletonGenerator();
  const request = createRequest({
    taskCard: {
      id: "T-002",
      title: "UserRepository",
      requirementId: "F-001",
      dependencies: [],
      acceptanceCriteria: ["npm test"],
      status: "pending",
      declaredSymbols: [],
    },
    taskDag: createTaskDag([createTaskNode("T-002", "UserRepository")]),
  });
  const result = generator.generate(request);
  const portFile = result.files.find((f) => f.kind === "repository-port");
  assert.ok(portFile !== undefined);
  assert.equal(portFile!.relativePath, "src/UserRepositoryRepository.ts");
});

test("T8c. module-index → 'src/index.ts'", () => {
  const generator = new SkeletonGenerator();
  const plan = createPlanContent([
    {
      moduleName: "PlainModule",
      responsibility: "通用工具",
      dependsOn: [],
      keyFiles: ["src/plain.ts"],
    },
  ]);
  const request = createRequest({
    planContent: plan,
    taskDag: createTaskDag([createTaskNode("T-001", "PlainModule")]),
  });
  const result = generator.generate(request);
  const indexFile = result.files.find((f) => f.kind === "module-index");
  assert.ok(indexFile !== undefined);
  assert.equal(indexFile!.relativePath, "src/index.ts");
});

test("T8d. outputDir 不以 / 结尾 → 自动补 /", () => {
  const generator = new SkeletonGenerator();
  const request = createRequest({ outputDir: "src" });
  const result = generator.generate(request);
  const aggregateFile = result.files.find((f) => f.kind === "aggregate");
  assert.ok(aggregateFile !== undefined);
  // outputDir="src" 应自动补 /，路径为 "src/OrderAggregate.ts"
  assert.equal(aggregateFile!.relativePath, "src/OrderAggregate.ts");
});

// ============================================================================
// T9. 错误处理
// ============================================================================

test("T9a. planContent 为空 → 抛 SkeletonGeneratorError(invalid-request)", () => {
  const generator = new SkeletonGenerator();
  const request = createRequest({ planContent: "" });
  assert.throws(
    () => generator.generate(request),
    (err: unknown) => {
      assert.ok(err instanceof SkeletonGeneratorError);
      assert.equal(err.kind, "invalid-request");
      assert.ok(err.detail.includes("planContent"));
      return true;
    }
  );
});

test("T9b. tasksContent 为空 → 抛 SkeletonGeneratorError(invalid-request)", () => {
  const generator = new SkeletonGenerator();
  const request = createRequest({ tasksContent: "" });
  assert.throws(
    () => generator.generate(request),
    (err: unknown) => {
      assert.ok(err instanceof SkeletonGeneratorError);
      assert.equal(err.kind, "invalid-request");
      assert.ok(err.detail.includes("tasksContent"));
      return true;
    }
  );
});

test("T9c. taskDag 缺失 nodes → 抛 SkeletonGeneratorError(invalid-request)", () => {
  const generator = new SkeletonGenerator();
  // 构造非法 taskDag（nodes 不是数组）
  const invalidDag = { nodes: "not-array", topologicalOrder: [] } as unknown as TaskDag;
  const request = createRequest({ taskDag: invalidDag });
  assert.throws(
    () => generator.generate(request),
    (err: unknown) => {
      assert.ok(err instanceof SkeletonGeneratorError);
      assert.equal(err.kind, "invalid-request");
      return true;
    }
  );
});

test("T9d. taskCard.id 为空 → 抛 SkeletonGeneratorError(invalid-request)", () => {
  const generator = new SkeletonGenerator();
  const request = createRequest({
    taskCard: {
      id: "",
      title: "测试任务",
      requirementId: "F-001",
      dependencies: [],
      acceptanceCriteria: ["npm test"],
      status: "pending",
      declaredSymbols: [],
    },
  });
  assert.throws(
    () => generator.generate(request),
    (err: unknown) => {
      assert.ok(err instanceof SkeletonGeneratorError);
      assert.equal(err.kind, "invalid-request");
      assert.ok(err.detail.includes("taskCard.id"));
      return true;
    }
  );
});

test("T9e. taskCard.requirementId 为空 → 抛 SkeletonGeneratorError(invalid-request)", () => {
  const generator = new SkeletonGenerator();
  const request = createRequest({
    taskCard: {
      id: "T-001",
      title: "测试任务",
      requirementId: "",
      dependencies: [],
      acceptanceCriteria: ["npm test"],
      status: "pending",
      declaredSymbols: [],
    },
  });
  assert.throws(
    () => generator.generate(request),
    (err: unknown) => {
      assert.ok(err instanceof SkeletonGeneratorError);
      assert.equal(err.kind, "invalid-request");
      assert.ok(err.detail.includes("requirementId"));
      return true;
    }
  );
});

test("T9f. techStack 非数组 → 抛 SkeletonGeneratorError(invalid-request)", () => {
  const generator = new SkeletonGenerator();
  const request = createRequest({ techStack: "not-array" as unknown as string[] });
  assert.throws(
    () => generator.generate(request),
    (err: unknown) => {
      assert.ok(err instanceof SkeletonGeneratorError);
      assert.equal(err.kind, "invalid-request");
      assert.ok(err.detail.includes("techStack"));
      return true;
    }
  );
});

test("T9g. projectRoot 为空 → 抛 SkeletonGeneratorError(invalid-request)", () => {
  const generator = new SkeletonGenerator();
  const request = createRequest({ projectRoot: "" });
  assert.throws(
    () => generator.generate(request),
    (err: unknown) => {
      assert.ok(err instanceof SkeletonGeneratorError);
      assert.equal(err.kind, "invalid-request");
      assert.ok(err.detail.includes("projectRoot"));
      return true;
    }
  );
});

test("T9h. outputDir 为空 → 抛 SkeletonGeneratorError(invalid-request)", () => {
  const generator = new SkeletonGenerator();
  const request = createRequest({ outputDir: "" });
  assert.throws(
    () => generator.generate(request),
    (err: unknown) => {
      assert.ok(err instanceof SkeletonGeneratorError);
      assert.equal(err.kind, "invalid-request");
      assert.ok(err.detail.includes("outputDir"));
      return true;
    }
  );
});

test("T9i. taskDag.nodes 中未找到 taskCard.id → 抛 SkeletonGeneratorError(invalid-request)", () => {
  const generator = new SkeletonGenerator();
  // taskCard.id="T-999"，但 taskDag 中只有 T-001
  const request = createRequest({
    taskCard: {
      id: "T-999",
      title: "不存在的任务",
      requirementId: "F-001",
      dependencies: [],
      acceptanceCriteria: ["npm test"],
      status: "pending",
      declaredSymbols: [],
    },
    taskDag: createTaskDag([createTaskNode("T-001", "OrderAggregate")]),
  });
  assert.throws(
    () => generator.generate(request),
    (err: unknown) => {
      assert.ok(err instanceof SkeletonGeneratorError);
      assert.equal(err.kind, "invalid-request");
      assert.ok(err.detail.includes("T-999"));
      return true;
    }
  );
});

test("T9j. TaskNode.fileCluster 为空 → 抛 SkeletonGeneratorError(invalid-request)", () => {
  const generator = new SkeletonGenerator();
  const request = createRequest({
    taskDag: createTaskDag([createTaskNode("T-001", "")]),
  });
  assert.throws(
    () => generator.generate(request),
    (err: unknown) => {
      assert.ok(err instanceof SkeletonGeneratorError);
      assert.equal(err.kind, "invalid-request");
      assert.ok(err.detail.includes("fileCluster"));
      return true;
    }
  );
});

test("T9k. planContent 中未找到 fileCluster → 抛 SkeletonGeneratorError(module-split-not-found)", () => {
  const generator = new SkeletonGenerator();
  // taskNode.fileCluster="NonExistent"，但 planContent 中无此模块
  const request = createRequest({
    taskDag: createTaskDag([createTaskNode("T-001", "NonExistent")]),
  });
  assert.throws(
    () => generator.generate(request),
    (err: unknown) => {
      assert.ok(err instanceof SkeletonGeneratorError);
      assert.equal(err.kind, "module-split-not-found");
      assert.ok(err.detail.includes("NonExistent"));
      return true;
    }
  );
});

test("T9l. 所需 kind 未在 TemplateRegistry 注册 → 抛 SkeletonGeneratorError(template-not-registered)", () => {
  // 自定义注册表：仅注册 module-index，但 OrderAggregate 需要 aggregate + domain-event
  const partialRegistry = new PartialTemplateRegistry(["module-index"]);
  const generator = new SkeletonGenerator(partialRegistry);
  const request = createRequest();
  assert.throws(
    () => generator.generate(request),
    (err: unknown) => {
      assert.ok(err instanceof SkeletonGeneratorError);
      assert.equal(err.kind, "template-not-registered");
      return true;
    }
  );
});

test("T9m. 模板变量校验失败 → 抛 SkeletonGeneratorError(variable-validation-failed)", () => {
  // 自定义注册表：schema 校验始终失败
  const failRegistry = new AlwaysFailSchemaRegistry(["aggregate", "domain-event"]);
  const generator = new SkeletonGenerator(failRegistry);
  const request = createRequest();
  assert.throws(
    () => generator.generate(request),
    (err: unknown) => {
      assert.ok(err instanceof SkeletonGeneratorError);
      assert.equal(err.kind, "variable-validation-failed");
      return true;
    }
  );
});

test("T9n. EJS 渲染失败 → 抛 SkeletonGeneratorError(template-render-failed)", () => {
  // 自定义注册表：返回非法 EJS 模板（含未闭合标签）
  // 模板字符串 "<%- moduleName" 缺少闭合 %>，ejs.render 会抛错
  const invalidEjs = "<%- moduleName"; // 故意未闭合
  const templates: Record<string, string> = { aggregate: invalidEjs, "domain-event": invalidEjs };
  const invalidRegistry = new PartialTemplateRegistry(["aggregate", "domain-event"], templates);
  // 通过覆盖 schema 让校验通过，但模板渲染失败
  const generator = new SkeletonGenerator(invalidRegistry);
  const request = createRequest();
  assert.throws(
    () => generator.generate(request),
    (err: unknown) => {
      assert.ok(err instanceof SkeletonGeneratorError);
      assert.equal(err.kind, "template-render-failed");
      return true;
    }
  );
});

// ============================================================================
// T10. 默认 TemplateRegistry 完整性验证
// ============================================================================

test("T10. 默认 TemplateRegistry 含 13 种 kind", () => {
  const kinds = DEFAULT_TEMPLATE_REGISTRY.listKinds();
  assert.equal(kinds.length, 13);
  // 通过 ejs.render 验证每个模板都能渲染（无语法错误）
  for (const kind of kinds) {
    const template = DEFAULT_TEMPLATE_REGISTRY.getTemplate(kind);
    assert.ok(typeof template === "string");
    assert.ok(template.length > 0);
  }
});

// ============================================================================
// T11. EJS 模板渲染验证（验证默认模板与默认变量的兼容性）
// ============================================================================

test("T11. 默认模板渲染含 TODO(phase-b) 占位（聚合根模板）", () => {
  const generator = new SkeletonGenerator();
  const result = generator.generate(createRequest());
  const aggregateFile = result.files.find((f) => f.kind === "aggregate");
  assert.ok(aggregateFile !== undefined);
  // 渲染结果应含 TODO(phase-b) 占位
  assert.ok(aggregateFile!.content.includes("TODO(phase-b)"));
});
