/**
 * ProgressiveContextLoader 单元测试（F-FOCUS-03，V2-P2 新增）
 *
 * 测试覆盖（V2_P2_IMPLEMENTATION_PLAN.md §4.3 + V2 测试方案 §2.7）：
 * - PCL-01: Metadata 层加载（任务类型/目标/思考数量）
 * - PCL-02: Instruction 层加载（目标/需求/约束/最近 3 条思考摘要）
 * - PCL-03: Resource 层加载（最近 5 条中间结果）
 * - PCL-04: loadAll 三层并行加载（返回值结构正确性 + totalTokens 累计）
 * - PCL-05: getBudgetAllocation 三层预算分配（10%/40%/50%）
 *
 * 所有测试使用真实 TaskContext 构造，禁止 mock。
 *
 * @module v2/tests/context/progressive-loader.test
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { ProgressiveContextLoader } from "../../context/progressive-loader";
import type { TaskContext, FocusPoint, ThoughtEntry, IntermediateResult } from "../../context/types";

// ============================================================================
// 辅助工厂
// ============================================================================

/**
 * 创建测试用 TaskContext（含 thoughtHistory 和 intermediateResults）
 *
 * @param overrides 覆盖字段（可选）
 * @returns TaskContext
 */
function createTaskContext(overrides?: {
  thoughts?: ThoughtEntry[];
  intermediates?: IntermediateResult[];
  goals?: string[];
  constraints?: string[];
  description?: string;
  taskType?: string;
}): TaskContext {
  return {
    taskId: "task-pcl-test",
    taskDefinition: {
      description: overrides?.description ?? "PCL 测试任务",
      goals: overrides?.goals ?? ["修复登录 bug"],
      constraints: overrides?.constraints ?? ["零依赖"],
      taskType: overrides?.taskType ?? "bugfix",
      expectedOutput: "测试通过",
    },
    taskState: {
      status: "in_progress",
      progress: 50,
      startedAt: new Date().toISOString(),
      currentStage: "测试中",
    },
    workingMemory: {
      focusPoints: [] as FocusPoint[],
      temporaryData: {},
      pendingItems: [],
      thoughtHistory: overrides?.thoughts ?? [],
      intermediateResults: overrides?.intermediates ?? [],
      contextWindow: [],
    },
    skillContext: { activeSkills: [], loadedHistory: [] },
    version: 1,
  };
}

/**
 * 创建测试用 ThoughtEntry
 *
 * @param thought 思考内容
 * @param stage 阶段名称
 * @param minutesAgo 几分钟前（用于排序验证）
 */
function createThought(thought: string, stage: string, minutesAgo: number = 0): ThoughtEntry {
  const ts = new Date(Date.now() - minutesAgo * 60_000).toISOString();
  return { timestamp: ts, thought, stage };
}

/**
 * 创建测试用 IntermediateResult
 *
 * @param result 结果内容
 * @param source 来源
 * @param minutesAgo 几分钟前
 */
function createIntermediate(result: string, source: string, minutesAgo: number = 0): IntermediateResult {
  const ts = new Date(Date.now() - minutesAgo * 60_000).toISOString();
  return { timestamp: ts, result, source };
}

// ============================================================================
// PCL 测试用例（PCL-01 ~ PCL-05）
// ============================================================================

// ============================================================
// PCL-01: Metadata 层加载（任务类型/目标/思考数量）
// ============================================================

test("PCL-01: Metadata 层加载（产出 progressive_metadata 片段，含任务类型/目标/思考数量）", async () => {
  const loader = new ProgressiveContextLoader({ tokenBudget: 10_000 });
  const thoughts = [
    createThought("第1条思考", "分析"),
    createThought("第2条思考", "实现"),
    createThought("第3条思考", "测试"),
  ];
  const task = createTaskContext({
    taskType: "bugfix",
    goals: ["修复登录 bug", "优化性能"],
    thoughts,
  });

  // 调用 loadMetadataLayer
  const metadata = await loader.loadMetadataLayer(task);

  // 断言 1：返回 1 个片段
  assert.equal(metadata.length, 1, "Metadata 层应返回 1 个片段");

  // 断言 2：片段 type 为 "progressive_metadata"
  assert.equal(metadata[0].type, "progressive_metadata", "片段 type 应为 progressive_metadata");

  // 断言 3：片段 relevance 为 1.0（最高优先级）
  assert.equal(metadata[0].relevance, 1.0, "Metadata 层 relevance 应为 1.0");

  // 断言 4：片段 source 含 taskId
  assert.ok(metadata[0].source.includes("task-pcl-test"), `片段 source 应含 taskId，实际：${metadata[0].source}`);

  // 断言 5：content 含任务类型
  assert.ok(metadata[0].content.includes("bugfix"), "content 应含任务类型 bugfix");

  // 断言 6：content 含任务目标
  assert.ok(metadata[0].content.includes("修复登录 bug"), "content 应含任务目标 '修复登录 bug'");
  assert.ok(metadata[0].content.includes("优化性能"), "content 应含任务目标 '优化性能'");

  // 断言 7：content 含思考数量
  assert.ok(metadata[0].content.includes("3"), `content 应含思考数量 3，实际：${metadata[0].content}`);
});

// ============================================================
// PCL-02: Instruction 层加载（目标/需求/约束/最近 3 条思考摘要）
// ============================================================

test("PCL-02: Instruction 层加载（产出 progressive_instruction 片段，含目标/需求/约束/最近 3 条思考摘要）", async () => {
  const loader = new ProgressiveContextLoader({ tokenBudget: 10_000, recentThoughtsCount: 3 });
  // 构造 5 条思考，验证只取最近 3 条
  const thoughts = [
    createThought("第1条思考（应被截断）", "分析", 50),
    createThought("第2条思考（应被截断）", "分析", 40),
    createThought("第3条思考（应保留）", "实现", 30),
    createThought("第4条思考（应保留）", "实现", 20),
    createThought("第5条思考（应保留）", "测试", 10),
  ];
  const task = createTaskContext({
    goals: ["修复登录 bug"],
    description: "用户报告登录后跳转错误页面",
    constraints: ["零依赖", "不影响现有功能"],
    thoughts,
  });

  // 调用 loadInstructionLayer
  const instruction = await loader.loadInstructionLayer(task);

  // 断言 1：返回 1 个片段
  assert.equal(instruction.length, 1, "Instruction 层应返回 1 个片段");

  // 断言 2：片段 type 为 "progressive_instruction"
  assert.equal(instruction[0].type, "progressive_instruction", "片段 type 应为 progressive_instruction");

  // 断言 3：片段 relevance 为 0.9（次高优先级）
  assert.equal(instruction[0].relevance, 0.9, "Instruction 层 relevance 应为 0.9");

  // 断言 4：content 含任务目标
  assert.ok(instruction[0].content.includes("修复登录 bug"), "content 应含任务目标");

  // 断言 5：content 含需求（description 字段映射）
  assert.ok(instruction[0].content.includes("用户报告登录后跳转错误页面"), "content 应含需求（description）");

  // 断言 6：content 含约束
  assert.ok(instruction[0].content.includes("零依赖"), "content 应含约束 '零依赖'");
  assert.ok(instruction[0].content.includes("不影响现有功能"), "content 应含约束 '不影响现有功能'");

  // 断言 7：content 含最近 3 条思考摘要（第3/4/5条）
  assert.ok(instruction[0].content.includes("第3条思考（应保留）"), "content 应含最近第3条思考");
  assert.ok(instruction[0].content.includes("第4条思考（应保留）"), "content 应含最近第4条思考");
  assert.ok(instruction[0].content.includes("第5条思考（应保留）"), "content 应含最近第5条思考");

  // 断言 8：content 不含被截断的思考（第1/2条）
  assert.ok(!instruction[0].content.includes("第1条思考（应被截断）"), "content 不应含被截断的第1条思考");
  assert.ok(!instruction[0].content.includes("第2条思考（应被截断）"), "content 不应含被截断的第2条思考");
});

// ============================================================
// PCL-03: Resource 层加载（最近 5 条中间结果）
// ============================================================

test("PCL-03: Resource 层加载（产出 progressive_resource 片段，含最近 5 条中间结果）", async () => {
  const loader = new ProgressiveContextLoader({ tokenBudget: 10_000, recentIntermediatesCount: 5 });
  // 构造 7 条中间结果，验证只取最近 5 条
  const intermediates = [
    createIntermediate("第1条中间结果（应被截断）", "grep", 70),
    createIntermediate("第2条中间结果（应被截断）", "grep", 60),
    createIntermediate("第3条中间结果（应保留）", "edit", 50),
    createIntermediate("第4条中间结果（应保留）", "edit", 40),
    createIntermediate("第5条中间结果（应保留）", "test", 30),
    createIntermediate("第6条中间结果（应保留）", "test", 20),
    createIntermediate("第7条中间结果（应保留）", "build", 10),
  ];
  const task = createTaskContext({ intermediates });

  // 调用 loadResourceLayer
  const resource = await loader.loadResourceLayer(task);

  // 断言 1：返回 1 个片段
  assert.equal(resource.length, 1, "Resource 层应返回 1 个片段");

  // 断言 2：片段 type 为 "progressive_resource"
  assert.equal(resource[0].type, "progressive_resource", "片段 type 应为 progressive_resource");

  // 断言 3：片段 relevance 为 0.7（最低优先级）
  assert.equal(resource[0].relevance, 0.7, "Resource 层 relevance 应为 0.7");

  // 断言 4：content 含最近 5 条中间结果（第3-7条）
  for (let i = 3; i <= 7; i++) {
    assert.ok(resource[0].content.includes(`第${i}条中间结果（应保留）`), `content 应含最近第${i}条中间结果`);
  }

  // 断言 5：content 不含被截断的中间结果（第1/2条）
  assert.ok(!resource[0].content.includes("第1条中间结果（应被截断）"), "content 不应含被截断的第1条中间结果");
  assert.ok(!resource[0].content.includes("第2条中间结果（应被截断）"), "content 不应含被截断的第2条中间结果");
});

// ============================================================
// PCL-03b: Resource 层无中间结果时返回空数组
// ============================================================

test("PCL-03b: Resource 层无中间结果时返回空数组（不产出空片段）", async () => {
  const loader = new ProgressiveContextLoader({ tokenBudget: 10_000 });
  // 无中间结果
  const task = createTaskContext({ intermediates: [] });

  const resource = await loader.loadResourceLayer(task);

  // 断言：返回空数组（不产出空片段，避免挤占预算）
  assert.equal(resource.length, 0, "无中间结果时 Resource 层应返回空数组");
});

// ============================================================
// PCL-04: loadAll 三层并行加载（返回值结构正确性 + totalTokens 累计）
// ============================================================

test("PCL-04: loadAll 三层并行加载（返回 metadata + instruction + resource + totalTokens）", async () => {
  const loader = new ProgressiveContextLoader({ tokenBudget: 10_000 });
  const thoughts = [createThought("分析问题", "分析"), createThought("实现方案", "实现")];
  const intermediates = [createIntermediate("找到 3 处问题", "grep"), createIntermediate("已修复核心函数", "edit")];
  const task = createTaskContext({ thoughts, intermediates });

  // 调用 loadAll（并行加载三层）
  const result = await loader.loadAll(task);

  // 断言 1：metadata 非空（始终至少 1 个片段）
  assert.ok(result.metadata.length >= 1, "metadata 应非空（始终加载）");
  assert.equal(result.metadata[0].type, "progressive_metadata", "metadata 片段类型正确");

  // 断言 2：instruction 非空（始终至少 1 个片段）
  assert.ok(result.instruction.length >= 1, "instruction 应非空（始终加载）");
  assert.equal(result.instruction[0].type, "progressive_instruction", "instruction 片段类型正确");

  // 断言 3：resource 非空（有中间结果时）
  assert.ok(result.resource.length >= 1, "resource 应非空（有中间结果时）");
  assert.equal(result.resource[0].type, "progressive_resource", "resource 片段类型正确");

  // 断言 4：totalTokens > 0（三层片段累计 token）
  assert.ok(result.totalTokens > 0, `totalTokens 应 > 0，实际：${result.totalTokens}`);

  // 断言 5：totalTokens 等于三层所有片段 content 长度 / 4（charsPerToken=4）
  const allSnippets = [...result.metadata, ...result.instruction, ...result.resource];
  const expectedTokens = Math.ceil(allSnippets.reduce((sum, s) => sum + s.content.length, 0) / 4);
  assert.equal(result.totalTokens, expectedTokens, `totalTokens 应为 ${expectedTokens}，实际：${result.totalTokens}`);
});

// ============================================================
// PCL-05: getBudgetAllocation 三层预算分配（10%/40%/50%）
// ============================================================

test("PCL-05: getBudgetAllocation 三层预算分配（tokenBudget=10000 → metadata=1000/instruction=4000/resource=5000）", () => {
  // tokenBudget=10000，比例 10%/40%/50%
  const loader = new ProgressiveContextLoader({
    tokenBudget: 10_000,
    metadataBudgetRatio: 0.1,
    instructionBudgetRatio: 0.4,
    resourceBudgetRatio: 0.5,
  });

  // 调用 getBudgetAllocation
  const allocation = loader.getBudgetAllocation();

  // 断言：三层预算按 10%/40%/50% 分配
  assert.equal(allocation.metadata, 1_000, "Metadata 层预算应为 1000（10000 * 0.1）");
  assert.equal(allocation.instruction, 4_000, "Instruction 层预算应为 4000（10000 * 0.4）");
  assert.equal(allocation.resource, 5_000, "Resource 层预算应为 5000（10000 * 0.5）");
});

// ============================================================
// PCL-05b: getBudgetAllocation 自定义比例（验证非默认比例也正确）
// ============================================================

test("PCL-05b: getBudgetAllocation 自定义比例（20%/30%/50%）", () => {
  // tokenBudget=20000，自定义比例 20%/30%/50%
  const loader = new ProgressiveContextLoader({
    tokenBudget: 20_000,
    metadataBudgetRatio: 0.2,
    instructionBudgetRatio: 0.3,
    resourceBudgetRatio: 0.5,
  });

  const allocation = loader.getBudgetAllocation();

  // 断言：三层预算按自定义比例分配
  assert.equal(allocation.metadata, 4_000, "Metadata 层预算应为 4000（20000 * 0.2）");
  assert.equal(allocation.instruction, 6_000, "Instruction 层预算应为 6000（20000 * 0.3）");
  assert.equal(allocation.resource, 10_000, "Resource 层预算应为 10000（20000 * 0.5）");
});
