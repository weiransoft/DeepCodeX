/**
 * EAG-P2 批次 9 S3 单元测试：Phase B 上下文装配器（ContextAssembler）
 *
 * 测试范围：
 * - T1. ContextAssembler 实例化
 *   - T1a. 默认构造（注入 PkcAccessor）→ 实例化成功
 *   - T1b. 自定义 tcsRedlines / enterpriseRedlines / ruleStore → 实例化成功
 *   - T1c. 实现 getTcsSpecs / getEnterpriseRedlines / getEffectiveRlisRules 便捷 API
 * - T2. assemble 成功路径
 *   - T2a. 返回 CodingContext 含全部字段
 *   - T2b. taskCard 透传
 *   - T2c. moduleSplit 解析自 planContent
 *   - T2d. l1GlobalView 来自 pkcAccessor
 *   - T2e. l2SemanticResults 来自 pkcAccessor
 *   - T2f. l3BusinessKnowledge 来自 pkcAccessor
 *   - T2g. rlisRules 来自 ruleStore.getEffectiveRules（severity 大写→小写）
 *   - T2h. tcsSpecs 来自 tcsRedlines 分组
 *   - T2i. enterpriseRedlines 透传
 *   - T2j. 结果对象已冻结
 * - T3. L2 语义检索结果过滤+排序+截断（§7 R7 风险缓解）
 *   - T3a. score < 0.5 的命中项被过滤
 *   - T3b. 按 score 降序排序
 *   - T3c. 仅保留 Top-5
 *   - T3d. 空命中列表 → 返回空数组
 *   - T3e. 全部低于阈值 → 返回空数组
 * - T4. TCS 分组（buildTcsSpecSummaries）
 *   - T4a. 5 个 componentId（TCS-CACHE / TCS-LDAP / TCS-OSS / TCS-SEC / TCS-SQL）
 *   - T4b. 按 componentId 字母序排序
 *   - T4c. 每个 TcsSpecSummary 含 portInterface 字符串
 *   - T4d. 每个 TcsSpecSummary.redlines 含原始红线列表
 * - T5. RLIS 规则转换（convertRulesToSummaries）
 *   - T5a. severity 大写→小写（BLOCKER→blocker / MAJOR→major / WARNING→warning）
 *   - T5b. 字段映射（id→ruleId / category / content）
 *   - T5c. 自定义 RuleStore 注入生效
 * - T6. 错误处理
 *   - T6a. taskCard.id 为空 → invalid-argument
 *   - T6b. taskCard.requirementId 为空 → invalid-argument
 *   - T6c. planContent 为空 → invalid-argument
 *   - T6d. projectRoot 为空 → invalid-argument
 *   - T6e. fileCluster 为空 → invalid-argument
 *   - T6f. pkcAccessor.searchL2 抛错 → pkc-access-failed
 *   - T6g. pkcAccessor.queryL1GlobalView 抛错 → pkc-access-failed
 *   - T6h. pkcAccessor.queryL3BusinessKnowledge 抛错 → pkc-access-failed
 *   - T6i. planContent 中未找到 fileCluster → module-split-not-found
 * - T7. 默认 RuleStore（SEED_RULES）行为
 *   - T7a. 默认 ruleStore 含 10 条 SEED 规则
 *   - T7b. getEffectiveRlisRules 返回 SEED_RULES
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止 mock，直接构造真实对象（InMemoryPkcAccessor 真实实现 / RuleStore 真实实现 / 真实 TCS_REDLINES / 真实 SEED_RULES）
 *
 * @module core/tests/eag-coding-context-assembler
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { ContextAssembler, ContextAssemblerError } from "../eag/coding/context-assembler";
import type { PkcAccessor, SemanticSearchHit, CodingContext } from "../eag/coding/types";
import type { RedlineDefinition } from "../eag/evaluator/types";
import type { TaskCard } from "../eag/doc-driven/types";
import { TCS_REDLINES } from "../eag/tcs/tcs-redlines";
import { ENTERPRISE_REDLINES } from "../eag/redlines/enterprise-rules";
import { RuleStore } from "../eag/rlis/rule-store";
import { SEED_RULES } from "../eag/rlis/seed-rules";
import type { UserRule } from "../eag/rlis/types";

// ============================================================================
// 真实实现：InMemoryPkcAccessor（非 mock，所有方法真实工作）
// ============================================================================

/**
 * 内存版 PKC 访问器（真实实现，非 mock）
 *
 * 设计原则（对齐项目规则"禁止 mock"）：
 * - 所有方法真实工作：queryL1GlobalView / searchL2 / queryL3BusinessKnowledge 返回真实数据
 * - 支持注入预设的 L1 / L2 / L3 数据，便于测试不同场景
 * - 支持注入 throwFn 模拟 PKC 访问失败（用于错误处理测试）
 *
 * 与生产环境真实 PKC 访问器的差异：
 * - 不读取实际文件系统，仅返回预设数据
 * - 不做向量检索，直接返回预设的 L2 命中列表
 * - 这是测试替身但不是 mock——所有方法都有真实业务逻辑（数据透传 + 异常透传）
 */
class InMemoryPkcAccessor implements PkcAccessor {
  /** 预设的 L1 全局视野数据 */
  private readonly l1Data: Readonly<Record<string, unknown>>;
  /** 预设的 L2 语义检索命中列表 */
  private readonly l2Hits: ReadonlyArray<SemanticSearchHit>;
  /** 预设的 L3 业务知识数据 */
  private readonly l3Data: Readonly<Record<string, unknown>>;
  /** 可选的失败模拟函数（用于错误处理测试，按方法名触发抛错） */
  private readonly throwFn?: (method: "l1" | "l2" | "l3") => void;
  /** 记录 searchL2 调用参数（便于断言） */
  public lastSearchL2Args?: { query: string; projectRoot: string; topK?: number };
  /** 记录 queryL1GlobalView 调用参数 */
  public lastQueryL1Args?: { projectRoot: string };
  /** 记录 queryL3BusinessKnowledge 调用参数 */
  public lastQueryL3Args?: { projectRoot: string };

  constructor(opts: {
    l1Data?: Readonly<Record<string, unknown>>;
    l2Hits?: ReadonlyArray<SemanticSearchHit>;
    l3Data?: Readonly<Record<string, unknown>>;
    throwFn?: (method: "l1" | "l2" | "l3") => void;
  }) {
    this.l1Data = opts.l1Data ?? { moduleClusters: [], entryPoints: [] };
    this.l2Hits = opts.l2Hits ?? [];
    this.l3Data = opts.l3Data ?? { flows: [], erDiagram: "" };
    this.throwFn = opts.throwFn;
  }

  async queryL1GlobalView(projectRoot: string): Promise<Readonly<Record<string, unknown>>> {
    this.lastQueryL1Args = { projectRoot };
    if (this.throwFn) this.throwFn("l1");
    return this.l1Data;
  }

  async searchL2(query: string, projectRoot: string, topK?: number): Promise<ReadonlyArray<SemanticSearchHit>> {
    this.lastSearchL2Args = { query, projectRoot, topK };
    if (this.throwFn) this.throwFn("l2");
    // 真实业务逻辑：按 topK 截断（对齐 PKC L2 检索器的 Top-K 行为）
    const topN = topK ?? this.l2Hits.length;
    return this.l2Hits.slice(0, topN);
  }

  async queryL3BusinessKnowledge(projectRoot: string): Promise<Readonly<Record<string, unknown>>> {
    this.lastQueryL3Args = { projectRoot };
    if (this.throwFn) this.throwFn("l3");
    return this.l3Data;
  }
}

// ============================================================================
// 辅助函数：构造 TaskCard
// ============================================================================

/**
 * 构造测试用 TaskCard（默认全部字段合法）
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
    declaredSymbols: [
      "src/domain/order/OrderAggregate.ts:OrderAggregate.create",
      "src/domain/order/OrderAggregate.ts:OrderAggregate.cancel",
    ],
    ...overrides,
  };
}

// ============================================================================
// 辅助函数：构造 plan.md 内容字符串
// ============================================================================

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

// ============================================================================
// 辅助函数：构造 SemanticSearchHit
// ============================================================================

/**
 * 构造测试用 SemanticSearchHit
 *
 * @param symbolId 符号 ID
 * @param score 相关性评分
 * @returns 完整的 SemanticSearchHit
 */
function createHit(symbolId: string, score: number): SemanticSearchHit {
  return {
    symbolId,
    filePath: `src/${symbolId}.ts`,
    signature: `function ${symbolId}()`,
    score,
    snippet: `// snippet for ${symbolId}`,
  };
}

// ============================================================================
// T1. ContextAssembler 实例化
// ============================================================================

test("T1a. 默认构造（注入 PkcAccessor）→ 实例化成功", () => {
  const pkc = new InMemoryPkcAccessor({});
  const assembler = new ContextAssembler(pkc);
  assert.ok(assembler instanceof ContextAssembler);
});

test("T1b. 自定义 tcsRedlines / enterpriseRedlines / ruleStore → 实例化成功", () => {
  const pkc = new InMemoryPkcAccessor({});
  // 自定义 TCS 红线（仅 1 条，便于测试）
  const customTcsRedlines: ReadonlyArray<RedlineDefinition> = Object.freeze([
    {
      id: "TCS-CACHE-01",
      name: "缓存 TTL",
      description: "缓存必须设置 TTL",
      severity: "blocker",
      checkMethod: "静态扫描",
      checkType: "static",
    },
  ]);
  // 自定义企业红线（仅 1 条）
  const customEnterpriseRedlines: ReadonlyArray<RedlineDefinition> = Object.freeze([
    {
      id: "E1",
      name: "事务边界",
      description: "跨聚合写操作必须通过 Saga",
      severity: "major",
      checkMethod: "静态扫描",
      checkType: "static",
    },
  ]);
  // 自定义 RuleStore（仅含 1 条 SEED 规则）
  const customRuleStore = new RuleStore(SEED_RULES.slice(0, 1));

  const assembler = new ContextAssembler(pkc, customTcsRedlines, customEnterpriseRedlines, customRuleStore);
  assert.ok(assembler instanceof ContextAssembler);
  // 验证自定义 redlines 生效
  assert.equal(assembler.getEnterpriseRedlines().length, 1);
  assert.equal(assembler.getTcsSpecs().length, 1);
  assert.equal(assembler.getEffectiveRlisRules().length, 1);
});

test("T1c. 实现 getTcsSpecs / getEnterpriseRedlines / getEffectiveRlisRules 便捷 API", () => {
  const pkc = new InMemoryPkcAccessor({});
  const assembler = new ContextAssembler(pkc);
  assert.equal(typeof assembler.getTcsSpecs, "function");
  assert.equal(typeof assembler.getEnterpriseRedlines, "function");
  assert.equal(typeof assembler.getEffectiveRlisRules, "function");
  // 默认 TCS_REDLINES 含 13 条
  assert.ok(assembler.getTcsSpecs().length > 0);
  // 默认 ENTERPRISE_REDLINES 含 8 条（E1~E8）
  assert.equal(assembler.getEnterpriseRedlines().length, 8);
  // 默认 RuleStore 含 10 条 SEED 规则
  assert.equal(assembler.getEffectiveRlisRules().length, 10);
});

// ============================================================================
// T2. assemble 成功路径
// ============================================================================

test("T2a. 返回 CodingContext 含全部字段", async () => {
  const pkc = new InMemoryPkcAccessor({
    l1Data: { moduleClusters: [{ name: "OrderModule" }] },
    l2Hits: [createHit("Order:create", 0.9)],
    l3Data: { flows: [{ id: "F-001" }] },
  });
  const assembler = new ContextAssembler(pkc);
  const taskCard = createTaskCard();
  const planContent = createPlanContent("OrderAggregate");
  const context = await assembler.assemble(taskCard, planContent, "/project", "OrderAggregate");

  // 验证 CodingContext 含全部字段
  assert.ok(context.l1GlobalView !== undefined);
  assert.ok(Array.isArray(context.l2SemanticResults));
  assert.ok(context.l3BusinessKnowledge !== undefined);
  assert.ok(Array.isArray(context.tcsSpecs));
  assert.ok(Array.isArray(context.rlisRules));
  assert.ok(Array.isArray(context.enterpriseRedlines));
  assert.ok(context.taskCard !== undefined);
  assert.ok(context.moduleSplit !== undefined);
});

test("T2b. taskCard 透传", async () => {
  const pkc = new InMemoryPkcAccessor({});
  const assembler = new ContextAssembler(pkc);
  const taskCard = createTaskCard({ id: "T-002", title: "测试任务 002" });
  const context = await assembler.assemble(taskCard, createPlanContent("OrderAggregate"), "/project", "OrderAggregate");
  assert.equal(context.taskCard.id, "T-002");
  assert.equal(context.taskCard.title, "测试任务 002");
});

test("T2c. moduleSplit 解析自 planContent", async () => {
  const pkc = new InMemoryPkcAccessor({});
  const assembler = new ContextAssembler(pkc);
  const context = await assembler.assemble(
    createTaskCard(),
    createPlanContent("OrderAggregate"),
    "/project",
    "OrderAggregate"
  );
  assert.equal(context.moduleSplit.moduleName, "OrderAggregate");
  assert.ok(context.moduleSplit.responsibility.includes("订单创建/取消"));
});

test("T2d. l1GlobalView 来自 pkcAccessor", async () => {
  const l1Data = { moduleClusters: [{ name: "TestModule" }], entryPoints: ["src/index.ts"] };
  const pkc = new InMemoryPkcAccessor({ l1Data });
  const assembler = new ContextAssembler(pkc);
  const context = await assembler.assemble(
    createTaskCard(),
    createPlanContent("OrderAggregate"),
    "/project",
    "OrderAggregate"
  );
  assert.deepEqual(context.l1GlobalView, l1Data);
});

test("T2e. l2SemanticResults 来自 pkcAccessor（含过滤+排序+截断）", async () => {
  const l2Hits = [createHit("Symbol1", 0.9), createHit("Symbol2", 0.8), createHit("Symbol3", 0.6)];
  const pkc = new InMemoryPkcAccessor({ l2Hits });
  const assembler = new ContextAssembler(pkc);
  const context = await assembler.assemble(
    createTaskCard(),
    createPlanContent("OrderAggregate"),
    "/project",
    "OrderAggregate"
  );
  // 3 条全部 score >= 0.5，全部保留，按 score 降序
  assert.equal(context.l2SemanticResults.length, 3);
  assert.equal(context.l2SemanticResults[0].symbolId, "Symbol1");
  assert.equal(context.l2SemanticResults[1].symbolId, "Symbol2");
  assert.equal(context.l2SemanticResults[2].symbolId, "Symbol3");
});

test("T2f. l3BusinessKnowledge 来自 pkcAccessor", async () => {
  const l3Data = { flows: [{ id: "F-001", name: "下单流程" }], erDiagram: "graph TD; A-->B" };
  const pkc = new InMemoryPkcAccessor({ l3Data });
  const assembler = new ContextAssembler(pkc);
  const context = await assembler.assemble(
    createTaskCard(),
    createPlanContent("OrderAggregate"),
    "/project",
    "OrderAggregate"
  );
  assert.deepEqual(context.l3BusinessKnowledge, l3Data);
});

test("T2g. rlisRules 来自 ruleStore.getEffectiveRules（severity 大写→小写）", async () => {
  const pkc = new InMemoryPkcAccessor({});
  const assembler = new ContextAssembler(pkc);
  const context = await assembler.assemble(
    createTaskCard(),
    createPlanContent("OrderAggregate"),
    "/project",
    "OrderAggregate"
  );
  // SEED_RULES 含 10 条，severity 全部为 BLOCKER / MAJOR
  // 转换后应为小写 blocker / major
  assert.equal(context.rlisRules.length, 10);
  for (const rule of context.rlisRules) {
    assert.ok(
      rule.severity === "blocker" || rule.severity === "major" || rule.severity === "warning",
      `severity 应为小写，实际为：${rule.severity}`
    );
  }
  // 至少含 1 条 blocker（SEED-01 / SEED-03 / SEED-06 / SEED-10）
  const blockers = context.rlisRules.filter((r) => r.severity === "blocker");
  assert.ok(blockers.length >= 1, "至少含 1 条 blocker");
});

test("T2h. tcsSpecs 来自 tcsRedlines 分组", async () => {
  const pkc = new InMemoryPkcAccessor({});
  const assembler = new ContextAssembler(pkc);
  const context = await assembler.assemble(
    createTaskCard(),
    createPlanContent("OrderAggregate"),
    "/project",
    "OrderAggregate"
  );
  // 默认 TCS_REDLINES 含 13 条，按 componentId 分组为 5 组
  assert.equal(context.tcsSpecs.length, 5);
  // 按 componentId 字母序排序
  const componentIds = context.tcsSpecs.map((s) => s.componentId);
  assert.deepEqual(componentIds, ["TCS-CACHE", "TCS-LDAP", "TCS-OSS", "TCS-SEC", "TCS-SQL"]);
});

test("T2i. enterpriseRedlines 透传", async () => {
  const pkc = new InMemoryPkcAccessor({});
  const assembler = new ContextAssembler(pkc);
  const context = await assembler.assemble(
    createTaskCard(),
    createPlanContent("OrderAggregate"),
    "/project",
    "OrderAggregate"
  );
  // 默认 ENTERPRISE_REDLINES 含 8 条（E1~E8）
  assert.equal(context.enterpriseRedlines.length, 8);
  assert.equal(context.enterpriseRedlines[0].id, "E1");
  assert.equal(context.enterpriseRedlines[7].id, "E8");
});

test("T2j. 结果对象已冻结", async () => {
  const pkc = new InMemoryPkcAccessor({});
  const assembler = new ContextAssembler(pkc);
  const context = await assembler.assemble(
    createTaskCard(),
    createPlanContent("OrderAggregate"),
    "/project",
    "OrderAggregate"
  );
  assert.equal(Object.isFrozen(context), true);
});

// ============================================================================
// T3. L2 语义检索结果过滤+排序+截断（§7 R7 风险缓解）
// ============================================================================

test("T3a. score < 0.5 的命中项被过滤", async () => {
  const l2Hits = [createHit("High1", 0.9), createHit("High2", 0.6), createHit("Low1", 0.4), createHit("Low2", 0.3)];
  const pkc = new InMemoryPkcAccessor({ l2Hits });
  const assembler = new ContextAssembler(pkc);
  const context = await assembler.assemble(
    createTaskCard(),
    createPlanContent("OrderAggregate"),
    "/project",
    "OrderAggregate"
  );
  // 仅 0.9 / 0.6 通过过滤
  assert.equal(context.l2SemanticResults.length, 2);
  assert.equal(context.l2SemanticResults[0].symbolId, "High1");
  assert.equal(context.l2SemanticResults[1].symbolId, "High2");
});

test("T3b. 按 score 降序排序", async () => {
  const l2Hits = [createHit("Low", 0.6), createHit("High", 0.95), createHit("Mid", 0.7)];
  const pkc = new InMemoryPkcAccessor({ l2Hits });
  const assembler = new ContextAssembler(pkc);
  const context = await assembler.assemble(
    createTaskCard(),
    createPlanContent("OrderAggregate"),
    "/project",
    "OrderAggregate"
  );
  // 按 score 降序：0.95 / 0.7 / 0.6
  assert.equal(context.l2SemanticResults[0].symbolId, "High");
  assert.equal(context.l2SemanticResults[1].symbolId, "Mid");
  assert.equal(context.l2SemanticResults[2].symbolId, "Low");
});

test("T3c. 仅保留 Top-5（超过 5 条时截断）", async () => {
  // 8 条全部 score >= 0.5，应截断为 Top-5
  const l2Hits = [
    createHit("S1", 0.95),
    createHit("S2", 0.9),
    createHit("S3", 0.85),
    createHit("S4", 0.8),
    createHit("S5", 0.75),
    createHit("S6", 0.7),
    createHit("S7", 0.65),
    createHit("S8", 0.6),
  ];
  const pkc = new InMemoryPkcAccessor({ l2Hits });
  const assembler = new ContextAssembler(pkc);
  const context = await assembler.assemble(
    createTaskCard(),
    createPlanContent("OrderAggregate"),
    "/project",
    "OrderAggregate"
  );
  assert.equal(context.l2SemanticResults.length, 5);
  // 截断后保留 Top-5（按 score 降序）
  assert.equal(context.l2SemanticResults[0].symbolId, "S1");
  assert.equal(context.l2SemanticResults[4].symbolId, "S5");
});

test("T3d. 空命中列表 → 返回空数组", async () => {
  const pkc = new InMemoryPkcAccessor({ l2Hits: [] });
  const assembler = new ContextAssembler(pkc);
  const context = await assembler.assemble(
    createTaskCard(),
    createPlanContent("OrderAggregate"),
    "/project",
    "OrderAggregate"
  );
  assert.equal(context.l2SemanticResults.length, 0);
});

test("T3e. 全部低于阈值 → 返回空数组", async () => {
  const l2Hits = [createHit("Low1", 0.4), createHit("Low2", 0.3), createHit("Low3", 0.1)];
  const pkc = new InMemoryPkcAccessor({ l2Hits });
  const assembler = new ContextAssembler(pkc);
  const context = await assembler.assemble(
    createTaskCard(),
    createPlanContent("OrderAggregate"),
    "/project",
    "OrderAggregate"
  );
  assert.equal(context.l2SemanticResults.length, 0);
});

// ============================================================================
// T4. TCS 分组（buildTcsSpecSummaries）
// ============================================================================

test("T4a. 5 个 componentId（TCS-CACHE / TCS-LDAP / TCS-OSS / TCS-SEC / TCS-SQL）", async () => {
  const pkc = new InMemoryPkcAccessor({});
  const assembler = new ContextAssembler(pkc);
  const tcsSpecs = assembler.getTcsSpecs();
  // 默认 TCS_REDLINES 含 5 个 componentId
  const componentIds = tcsSpecs.map((s) => s.componentId);
  assert.ok(componentIds.includes("TCS-CACHE"));
  assert.ok(componentIds.includes("TCS-LDAP"));
  assert.ok(componentIds.includes("TCS-OSS"));
  assert.ok(componentIds.includes("TCS-SEC"));
  assert.ok(componentIds.includes("TCS-SQL"));
});

test("T4b. 按 componentId 字母序排序", () => {
  const pkc = new InMemoryPkcAccessor({});
  const assembler = new ContextAssembler(pkc);
  const componentIds = assembler.getTcsSpecs().map((s) => s.componentId);
  const sorted = [...componentIds].sort();
  assert.deepEqual(componentIds, sorted);
});

test("T4c. 每个 TcsSpecSummary 含 portInterface 字符串", () => {
  const pkc = new InMemoryPkcAccessor({});
  const assembler = new ContextAssembler(pkc);
  const tcsSpecs = assembler.getTcsSpecs();
  for (const spec of tcsSpecs) {
    assert.ok(spec.portInterface.length > 0, `componentId=${spec.componentId} 的 portInterface 应非空`);
    // 验证 portInterface 含 interface 关键字
    assert.ok(spec.portInterface.includes("interface"), `portInterface 应含 interface 关键字`);
  }
});

test("T4d. 每个 TcsSpecSummary.redlines 含原始红线列表", () => {
  const pkc = new InMemoryPkcAccessor({});
  const assembler = new ContextAssembler(pkc);
  const tcsSpecs = assembler.getTcsSpecs();
  // 验证 redlines 数量：TCS-CACHE 含 3 条 / TCS-LDAP 含 2 条 / TCS-OSS 含 1 条 / TCS-SEC 含 2 条 / TCS-SQL 含 3 条
  const cacheSpec = tcsSpecs.find((s) => s.componentId === "TCS-CACHE");
  assert.ok(cacheSpec);
  assert.ok(cacheSpec.redlines.length >= 1);
  // 每条 redline 含 id / name / severity 字段
  for (const redline of cacheSpec.redlines) {
    assert.ok(redline.id.startsWith("TCS-CACHE-"));
    assert.ok(typeof redline.name === "string");
    assert.ok(typeof redline.severity === "string");
  }
});

// ============================================================================
// T5. RLIS 规则转换（convertRulesToSummaries）
// ============================================================================

test("T5a. severity 大写→小写（BLOCKER→blocker / MAJOR→major / WARNING→warning）", async () => {
  const pkc = new InMemoryPkcAccessor({});
  // 自定义 RuleStore 含 3 种 severity 的规则
  const customRules: ReadonlyArray<UserRule> = Object.freeze([
    {
      id: "TEST-BLOCKER",
      category: "code-truth",
      severity: "BLOCKER",
      content: "测试 BLOCKER",
      source: "builtin-seed",
      confirmedBy: "auto",
      usageCount: 0,
      violationCount: 0,
      createdAt: "2026-07-18T00:00:00.000Z",
    },
    {
      id: "TEST-MAJOR",
      category: "comment-style",
      severity: "MAJOR",
      content: "测试 MAJOR",
      source: "builtin-seed",
      confirmedBy: "auto",
      usageCount: 0,
      violationCount: 0,
      createdAt: "2026-07-18T00:00:00.000Z",
    },
    {
      id: "TEST-WARNING",
      category: "quality-gate",
      severity: "WARNING",
      content: "测试 WARNING",
      source: "builtin-seed",
      confirmedBy: "auto",
      usageCount: 0,
      violationCount: 0,
      createdAt: "2026-07-18T00:00:00.000Z",
    },
  ]);
  const customRuleStore = new RuleStore(customRules);
  const assembler = new ContextAssembler(pkc, undefined, undefined, customRuleStore);
  const context = await assembler.assemble(
    createTaskCard(),
    createPlanContent("OrderAggregate"),
    "/project",
    "OrderAggregate"
  );
  // 验证 severity 转换
  const blocker = context.rlisRules.find((r) => r.ruleId === "TEST-BLOCKER");
  const major = context.rlisRules.find((r) => r.ruleId === "TEST-MAJOR");
  const warning = context.rlisRules.find((r) => r.ruleId === "TEST-WARNING");
  assert.equal(blocker?.severity, "blocker");
  assert.equal(major?.severity, "major");
  assert.equal(warning?.severity, "warning");
});

test("T5b. 字段映射（id→ruleId / category / content）", async () => {
  const pkc = new InMemoryPkcAccessor({});
  const customRules: ReadonlyArray<UserRule> = Object.freeze([
    {
      id: "TEST-MAPPING",
      category: "code-truth",
      severity: "MAJOR",
      content: "字段映射测试内容",
      source: "builtin-seed",
      confirmedBy: "auto",
      usageCount: 0,
      violationCount: 0,
      createdAt: "2026-07-18T00:00:00.000Z",
    },
  ]);
  const customRuleStore = new RuleStore(customRules);
  const assembler = new ContextAssembler(pkc, undefined, undefined, customRuleStore);
  const context = await assembler.assemble(
    createTaskCard(),
    createPlanContent("OrderAggregate"),
    "/project",
    "OrderAggregate"
  );
  const rule = context.rlisRules.find((r) => r.ruleId === "TEST-MAPPING");
  assert.ok(rule);
  assert.equal(rule.ruleId, "TEST-MAPPING");
  assert.equal(rule.category, "code-truth");
  assert.equal(rule.content, "字段映射测试内容");
  assert.equal(rule.severity, "major");
});

test("T5c. 自定义 RuleStore 注入生效", async () => {
  const pkc = new InMemoryPkcAccessor({});
  const customRules: ReadonlyArray<UserRule> = Object.freeze([
    {
      id: "CUSTOM-01",
      category: "code-truth",
      severity: "BLOCKER",
      content: "自定义规则 01",
      source: "user-explicit",
      confirmedBy: "auto",
      usageCount: 0,
      violationCount: 0,
      createdAt: "2026-07-18T00:00:00.000Z",
    },
  ]);
  const customRuleStore = new RuleStore(customRules);
  const assembler = new ContextAssembler(pkc, undefined, undefined, customRuleStore);
  // 验证 getEffectiveRlisRules 返回自定义规则
  const rules = assembler.getEffectiveRlisRules();
  assert.equal(rules.length, 1);
  assert.equal(rules[0].id, "CUSTOM-01");
});

// ============================================================================
// T6. 错误处理
// ============================================================================

test("T6a. taskCard.id 为空 → invalid-argument", async () => {
  const pkc = new InMemoryPkcAccessor({});
  const assembler = new ContextAssembler(pkc);
  const badTaskCard = createTaskCard({ id: "" });
  await assert.rejects(
    () => assembler.assemble(badTaskCard, createPlanContent(), "/project", "OrderAggregate"),
    (err: unknown) => {
      assert.ok(err instanceof ContextAssemblerError);
      assert.equal((err as ContextAssemblerError).kind, "invalid-argument");
      assert.ok((err as ContextAssemblerError).detail.includes("taskCard.id"));
      return true;
    }
  );
});

test("T6b. taskCard.requirementId 为空 → invalid-argument", async () => {
  const pkc = new InMemoryPkcAccessor({});
  const assembler = new ContextAssembler(pkc);
  const badTaskCard = createTaskCard({ requirementId: "" });
  await assert.rejects(
    () => assembler.assemble(badTaskCard, createPlanContent(), "/project", "OrderAggregate"),
    (err: unknown) => {
      assert.ok(err instanceof ContextAssemblerError);
      assert.equal((err as ContextAssemblerError).kind, "invalid-argument");
      assert.ok((err as ContextAssemblerError).detail.includes("requirementId"));
      return true;
    }
  );
});

test("T6c. planContent 为空 → invalid-argument", async () => {
  const pkc = new InMemoryPkcAccessor({});
  const assembler = new ContextAssembler(pkc);
  await assert.rejects(
    () => assembler.assemble(createTaskCard(), "", "/project", "OrderAggregate"),
    (err: unknown) => {
      assert.ok(err instanceof ContextAssemblerError);
      assert.equal((err as ContextAssemblerError).kind, "invalid-argument");
      assert.ok((err as ContextAssemblerError).detail.includes("planContent"));
      return true;
    }
  );
});

test("T6d. projectRoot 为空 → invalid-argument", async () => {
  const pkc = new InMemoryPkcAccessor({});
  const assembler = new ContextAssembler(pkc);
  await assert.rejects(
    () => assembler.assemble(createTaskCard(), createPlanContent(), "", "OrderAggregate"),
    (err: unknown) => {
      assert.ok(err instanceof ContextAssemblerError);
      assert.equal((err as ContextAssemblerError).kind, "invalid-argument");
      assert.ok((err as ContextAssemblerError).detail.includes("projectRoot"));
      return true;
    }
  );
});

test("T6e. fileCluster 为空 → invalid-argument", async () => {
  const pkc = new InMemoryPkcAccessor({});
  const assembler = new ContextAssembler(pkc);
  await assert.rejects(
    () => assembler.assemble(createTaskCard(), createPlanContent(), "/project", ""),
    (err: unknown) => {
      assert.ok(err instanceof ContextAssemblerError);
      assert.equal((err as ContextAssemblerError).kind, "invalid-argument");
      assert.ok((err as ContextAssemblerError).detail.includes("fileCluster"));
      return true;
    }
  );
});

test("T6f. pkcAccessor.searchL2 抛错 → pkc-access-failed", async () => {
  const pkc = new InMemoryPkcAccessor({
    throwFn: (method) => {
      if (method === "l2") throw new Error("L2 检索失败：向量索引未初始化");
    },
  });
  const assembler = new ContextAssembler(pkc);
  await assert.rejects(
    () => assembler.assemble(createTaskCard(), createPlanContent(), "/project", "OrderAggregate"),
    (err: unknown) => {
      assert.ok(err instanceof ContextAssemblerError);
      assert.equal((err as ContextAssemblerError).kind, "pkc-access-failed");
      assert.ok((err as ContextAssemblerError).detail.includes("searchL2"));
      assert.ok((err as ContextAssemblerError).detail.includes("向量索引未初始化"));
      return true;
    }
  );
});

test("T6g. pkcAccessor.queryL1GlobalView 抛错 → pkc-access-failed", async () => {
  const pkc = new InMemoryPkcAccessor({
    throwFn: (method) => {
      if (method === "l1") throw new Error("L1 查询失败：模块聚类未构建");
    },
  });
  const assembler = new ContextAssembler(pkc);
  await assert.rejects(
    () => assembler.assemble(createTaskCard(), createPlanContent(), "/project", "OrderAggregate"),
    (err: unknown) => {
      assert.ok(err instanceof ContextAssemblerError);
      assert.equal((err as ContextAssemblerError).kind, "pkc-access-failed");
      assert.ok((err as ContextAssemblerError).detail.includes("queryL1GlobalView"));
      assert.ok((err as ContextAssemblerError).detail.includes("模块聚类未构建"));
      return true;
    }
  );
});

test("T6h. pkcAccessor.queryL3BusinessKnowledge 抛错 → pkc-access-failed", async () => {
  const pkc = new InMemoryPkcAccessor({
    throwFn: (method) => {
      if (method === "l3") throw new Error("L3 查询失败：ER 图缺失");
    },
  });
  const assembler = new ContextAssembler(pkc);
  await assert.rejects(
    () => assembler.assemble(createTaskCard(), createPlanContent(), "/project", "OrderAggregate"),
    (err: unknown) => {
      assert.ok(err instanceof ContextAssemblerError);
      assert.equal((err as ContextAssemblerError).kind, "pkc-access-failed");
      assert.ok((err as ContextAssemblerError).detail.includes("queryL3BusinessKnowledge"));
      assert.ok((err as ContextAssemblerError).detail.includes("ER 图缺失"));
      return true;
    }
  );
});

test("T6i. planContent 中未找到 fileCluster → module-split-not-found", async () => {
  const pkc = new InMemoryPkcAccessor({});
  const assembler = new ContextAssembler(pkc);
  // plan.md 含 OrderAggregate 模块，但 fileCluster 传入 NonExistentModule
  await assert.rejects(
    () => assembler.assemble(createTaskCard(), createPlanContent("OrderAggregate"), "/project", "NonExistentModule"),
    (err: unknown) => {
      assert.ok(err instanceof ContextAssemblerError);
      assert.equal((err as ContextAssemblerError).kind, "module-split-not-found");
      assert.ok((err as ContextAssemblerError).detail.includes("NonExistentModule"));
      return true;
    }
  );
});

// ============================================================================
// T7. 默认 RuleStore（SEED_RULES）行为
// ============================================================================

test("T7a. 默认 ruleStore 含 10 条 SEED 规则", () => {
  const pkc = new InMemoryPkcAccessor({});
  const assembler = new ContextAssembler(pkc);
  const rules = assembler.getEffectiveRlisRules();
  assert.equal(rules.length, 10);
  // 验证 ID 范围 SEED-01 ~ SEED-10
  for (let i = 1; i <= 10; i++) {
    const id = `SEED-${i.toString().padStart(2, "0")}`;
    assert.ok(
      rules.find((r) => r.id === id),
      `应含 ${id}`
    );
  }
});

test("T7b. getEffectiveRlisRules 返回 SEED_RULES（按 severity 排序）", () => {
  const pkc = new InMemoryPkcAccessor({});
  const assembler = new ContextAssembler(pkc);
  const rules = assembler.getEffectiveRlisRules();
  // RuleStore 按 severity 排序（BLOCKER 优先 → MAJOR → WARNING），
  // 同 severity 内按 ID 字母序排序（保证测试可重现）
  // SEED_RULES 中 BLOCKER：SEED-01 / SEED-03 / SEED-06 / SEED-10
  // SEED_RULES 中 MAJOR：SEED-02 / SEED-04 / SEED-05 / SEED-07 / SEED-08 / SEED-09
  const ruleIds = rules.map((r) => r.id);
  const expectedOrder = [
    "SEED-01",
    "SEED-03",
    "SEED-06",
    "SEED-10", // BLOCKER（按 ID 字母序）
    "SEED-02",
    "SEED-04",
    "SEED-05",
    "SEED-07",
    "SEED-08",
    "SEED-09", // MAJOR（按 ID 字母序）
  ];
  assert.deepEqual(ruleIds, expectedOrder);
  // 比对 ID 集合（忽略顺序）
  const ruleIdSet = new Set(ruleIds);
  const seedIdSet = new Set(SEED_RULES.map((r) => r.id));
  assert.deepEqual(ruleIdSet, seedIdSet);
});

// ============================================================================
// T8. assemble 调用 PKC 时传参正确性
// ============================================================================

test("T8a. pkcAccessor.searchL2 收到正确的 query / projectRoot / topK 参数", async () => {
  const pkc = new InMemoryPkcAccessor({});
  const assembler = new ContextAssembler(pkc);
  await assembler.assemble(createTaskCard(), createPlanContent("OrderAggregate"), "/test/project", "OrderAggregate");
  assert.ok(pkc.lastSearchL2Args);
  assert.equal(pkc.lastSearchL2Args.query, "OrderAggregate");
  assert.equal(pkc.lastSearchL2Args.projectRoot, "/test/project");
  // topK 应为 10（L2_SEARCH_TOP_K 常量）
  assert.equal(pkc.lastSearchL2Args.topK, 10);
});

test("T8b. pkcAccessor.queryL1GlobalView 收到正确的 projectRoot 参数", async () => {
  const pkc = new InMemoryPkcAccessor({});
  const assembler = new ContextAssembler(pkc);
  await assembler.assemble(createTaskCard(), createPlanContent("OrderAggregate"), "/test/project", "OrderAggregate");
  assert.ok(pkc.lastQueryL1Args);
  assert.equal(pkc.lastQueryL1Args.projectRoot, "/test/project");
});

test("T8c. pkcAccessor.queryL3BusinessKnowledge 收到正确的 projectRoot 参数", async () => {
  const pkc = new InMemoryPkcAccessor({});
  const assembler = new ContextAssembler(pkc);
  await assembler.assemble(createTaskCard(), createPlanContent("OrderAggregate"), "/test/project", "OrderAggregate");
  assert.ok(pkc.lastQueryL3Args);
  assert.equal(pkc.lastQueryL3Args.projectRoot, "/test/project");
});

// ============================================================================
// T9. CodingContext 类型契约
// ============================================================================

test("T9a. CodingContext 字段全部 readonly（运行期不可变）", async () => {
  const pkc = new InMemoryPkcAccessor({});
  const assembler = new ContextAssembler(pkc);
  const context: CodingContext = await assembler.assemble(
    createTaskCard(),
    createPlanContent("OrderAggregate"),
    "/project",
    "OrderAggregate"
  );
  // 验证顶层对象冻结
  assert.equal(Object.isFrozen(context), true);
  // 验证 taskCard 字段不可重新赋值（严格模式下抛错）
  assert.throws(() => {
    // @ts-expect-error 故意测试 readonly 不可变性
    (context as { taskCard: unknown }).taskCard = createTaskCard({ id: "T-999" });
  }, TypeError);
});

test("T9b. enterpriseRedlines 字段为 ENTERPRISE_REDLINES 引用", async () => {
  const pkc = new InMemoryPkcAccessor({});
  const assembler = new ContextAssembler(pkc);
  const context = await assembler.assemble(
    createTaskCard(),
    createPlanContent("OrderAggregate"),
    "/project",
    "OrderAggregate"
  );
  // 默认 enterpriseRedlines 应为 ENTERPRISE_REDLINES 引用
  // 验证 ID 列表对齐
  const ids = context.enterpriseRedlines.map((r) => r.id);
  const expectedIds = ENTERPRISE_REDLINES.map((r) => r.id);
  assert.deepEqual(ids, expectedIds);
});

test("T9c. tcsSpecs 字段为预构建缓存（多次 assemble 共享同一引用）", async () => {
  const pkc = new InMemoryPkcAccessor({});
  const assembler = new ContextAssembler(pkc);
  const context1 = await assembler.assemble(
    createTaskCard(),
    createPlanContent("OrderAggregate"),
    "/project",
    "OrderAggregate"
  );
  const context2 = await assembler.assemble(
    createTaskCard(),
    createPlanContent("OrderAggregate"),
    "/project",
    "OrderAggregate"
  );
  // tcsSpecs 应为同一引用（预构建缓存）
  assert.equal(context1.tcsSpecs, context2.tcsSpecs);
});
