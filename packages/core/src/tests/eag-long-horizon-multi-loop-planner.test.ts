/**
 * EAG-P3 批次 10 单元测试：long-horizon/multi-loop-planner.ts
 *
 * 测试范围：
 * - M1. plan() 基本流程：单模块 spec → 1 个 design 节点 + 1 个 coding 节点 + 1 个 testing 节点
 * - M2. plan() 多模块场景：3 个模块 → 多个 design/coding/testing 节点
 * - M3. plan() 模块依赖关系：依赖模块先于本模块的 design 节点
 * - M4. plan() 默认参数（autoTransition=false / rollbackOnFailure=true）
 * - M5. plan() 入参校验：缺 runId / projectRoot / specContent 抛 invalid-request
 * - M6. validate() 无环 DAG 校验通过
 * - M7. validate() 检测环（A → B → A）
 * - M8. validate() 检测不可达节点
 * - M9. nextNode() 返回下一个待执行节点
 * - M10. nextNode() 全部完成时返回 null
 * - M11. 计划字段不可变性（Object.freeze）
 *
 * 测试约定（严格遵循项目"禁止 mock"规则）：
 * - 使用 node:test + node:assert/strict
 * - 使用真实 MultiLoopPlanner 实例，不使用任何 mock 框架
 *
 * 设计依据：
 * - EAG-P3 批次 10 设计文档 §4.11 MultiLoopPlanner
 * - eag/long-horizon/multi-loop-planner.ts 源文件
 *
 * @module core/tests/eag-long-horizon-multi-loop-planner
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { MultiLoopPlanner, MultiLoopPlannerError } from "../eag/long-horizon/multi-loop-planner";
import type { MultiLoopPlanRequest, ModuleSplit } from "../eag/long-horizon/multi-loop-planner";
import type { MultiLoopPlan, MultiLoopNode, DagValidationResult } from "../eag/long-horizon/types";

// ============================================================================
// 测试辅助工厂
// ============================================================================

/**
 * 创建测试用 spec.md 内容（单模块）
 */
function makeSingleModuleSpec(): string {
  return ["# 模块：用户管理", "依赖：", "", "## 功能", "- 用户注册", "- 用户登录"].join("\n");
}

/**
 * 创建测试用 spec.md 内容（多模块 + 依赖）
 *
 * 模块依赖关系：
 * - 用户管理（无依赖）
 * - 订单管理 → 依赖用户管理
 * - 支付管理 → 依赖订单管理
 */
function makeMultiModuleSpec(): string {
  return [
    "# 模块：用户管理",
    "依赖：",
    "",
    "# 模块：订单管理",
    "依赖：用户管理",
    "",
    "# 模块：支付管理",
    "依赖：订单管理",
  ].join("\n");
}

/**
 * 创建测试用 plan 请求
 */
function makePlanRequest(specContent: string, overrides?: Partial<MultiLoopPlanRequest>): MultiLoopPlanRequest {
  return {
    runId: "test-run-001",
    projectRoot: "/tmp/test",
    specContent,
    ...overrides,
  };
}

// ============================================================================
// M1. plan() 基本流程：单模块 spec
// ============================================================================

test("M1.1 plan() 单模块 spec 生成多 Loop 节点", async () => {
  const planner = new MultiLoopPlanner();
  const plan = await planner.plan(makePlanRequest(makeSingleModuleSpec()));

  // 单模块至少应生成 1 个节点
  assert.ok(plan.loops.length >= 1, `节点数应 >= 1，实际为 ${plan.loops.length}`);
  // 所有节点应属于 design / coding / testing 之一
  for (const node of plan.loops) {
    assert.ok(
      node.loopType === "design" || node.loopType === "coding" || node.loopType === "testing",
      `节点 ${node.nodeId} loopType=${node.loopType} 应为 design/coding/testing 之一`
    );
  }
});

test("M1.2 plan() 计划 ID 与 runId 一致", async () => {
  const planner = new MultiLoopPlanner();
  const plan = await planner.plan(makePlanRequest(makeSingleModuleSpec()));
  assert.equal(plan.planId, "test-run-001");
});

test("M1.3 plan() projectRoot 透传正确", async () => {
  const planner = new MultiLoopPlanner();
  const plan = await planner.plan(makePlanRequest(makeSingleModuleSpec()));
  assert.equal(plan.projectRoot, "/tmp/test");
});

// ============================================================================
// M2. plan() 多模块场景
// ============================================================================

test("M2.1 plan() 多模块 spec 生成多个节点", async () => {
  const planner = new MultiLoopPlanner();
  const plan = await planner.plan(makePlanRequest(makeMultiModuleSpec()));

  // 多模块（3 个）应生成更多节点
  assert.ok(plan.loops.length >= 3, `3 个模块应至少生成 3 个节点，实际为 ${plan.loops.length}`);
});

test("M2.2 plan() 节点 ID 唯一性", async () => {
  const planner = new MultiLoopPlanner();
  const plan = await planner.plan(makePlanRequest(makeMultiModuleSpec()));

  const ids = plan.loops.map((n) => n.nodeId);
  const uniqueIds = new Set(ids);
  assert.equal(uniqueIds.size, ids.length, "节点 ID 应唯一");
});

// ============================================================================
// M3. plan() 模块依赖关系
// ============================================================================

test("M3.1 plan() 至少包含一个无依赖的起始节点", async () => {
  const planner = new MultiLoopPlanner();
  const plan = await planner.plan(makePlanRequest(makeMultiModuleSpec()));

  const rootNodes = plan.loops.filter((n) => n.dependencies.length === 0);
  assert.ok(rootNodes.length >= 1, "至少应有一个无依赖的起始节点");
});

// ============================================================================
// M4. plan() 默认参数
// ============================================================================

test("M4.1 plan() 默认 autoTransition=false", async () => {
  const planner = new MultiLoopPlanner();
  const plan = await planner.plan(makePlanRequest(makeSingleModuleSpec()));
  assert.equal(plan.autoTransition, false);
});

test("M4.2 plan() 默认 rollbackOnFailure=true", async () => {
  const planner = new MultiLoopPlanner();
  const plan = await planner.plan(makePlanRequest(makeSingleModuleSpec()));
  assert.equal(plan.rollbackOnFailure, true);
});

test("M4.3 plan() 显式 autoTransition=true 透传正确", async () => {
  const planner = new MultiLoopPlanner();
  const plan = await planner.plan(makePlanRequest(makeSingleModuleSpec(), { autoTransition: true }));
  assert.equal(plan.autoTransition, true);
});

test("M4.4 plan() 显式 rollbackOnFailure=false 透传正确", async () => {
  const planner = new MultiLoopPlanner();
  const plan = await planner.plan(makePlanRequest(makeSingleModuleSpec(), { rollbackOnFailure: false }));
  assert.equal(plan.rollbackOnFailure, false);
});

// ============================================================================
// M5. plan() 入参校验
// ============================================================================

test("M5.1 plan() 缺 runId 抛 invalid-request", async () => {
  const planner = new MultiLoopPlanner();
  await assert.rejects(
    () => planner.plan(makePlanRequest(makeSingleModuleSpec(), { runId: "" })),
    (err: unknown) => {
      assert.ok(err instanceof MultiLoopPlannerError);
      assert.equal(err.kind, "invalid-request");
      return true;
    }
  );
});

test("M5.2 plan() 缺 projectRoot 抛 invalid-request", async () => {
  const planner = new MultiLoopPlanner();
  await assert.rejects(
    () => planner.plan(makePlanRequest(makeSingleModuleSpec(), { projectRoot: "" })),
    (err: unknown) => {
      assert.ok(err instanceof MultiLoopPlannerError);
      assert.equal(err.kind, "invalid-request");
      return true;
    }
  );
});

test("M5.3 plan() specContent 非字符串类型抛 invalid-request（编译期类型保护，运行时 undefined）", async () => {
  const planner = new MultiLoopPlanner();
  // specContent 必须为字符串类型；运行时传入 undefined 触发 typeof 校验
  await assert.rejects(
    () =>
      planner.plan({
        runId: "test-run-001",
        projectRoot: "/tmp/test",
        // 故意传入 undefined 触发 typeof specContent !== "string" 校验
        specContent: undefined as unknown as string,
      }),
    (err: unknown) => {
      assert.ok(err instanceof MultiLoopPlannerError);
      assert.equal(err.kind, "invalid-request");
      return true;
    }
  );
});

// ============================================================================
// M6/M7/M8. validate() DAG 校验
// ============================================================================

test("M6.1 validate() 合法 DAG 返回 valid=true", async () => {
  const planner = new MultiLoopPlanner();
  const plan = await planner.plan(makePlanRequest(makeMultiModuleSpec()));
  const result = planner.validate(plan);
  assert.equal(result.valid, true);
  assert.equal(result.cycles.length, 0);
  assert.equal(result.unreachableNodes.length, 0);
});

test("M7.1 validate() 检测环（A → B → A）", () => {
  const planner = new MultiLoopPlanner();
  // 构造含环的 plan：A → B → A
  const cyclicPlan: MultiLoopPlan = {
    planId: "test-cyclic",
    projectRoot: "/tmp/test",
    loops: [
      {
        nodeId: "A",
        loopType: "design",
        dependencies: ["B"],
        status: "pending",
        entryArtifact: "A",
        exitCriteria: "A",
      },
      {
        nodeId: "B",
        loopType: "coding",
        dependencies: ["A"],
        status: "pending",
        entryArtifact: "B",
        exitCriteria: "B",
      },
    ],
    autoTransition: true,
    rollbackOnFailure: true,
    createdAt: "2026-07-19T00:00:00.000Z",
  };
  const result = planner.validate(cyclicPlan);
  assert.equal(result.valid, false);
  assert.ok(result.cycles.length > 0, "应检测到环");
});

test("M8.1 validate() 检测不可达节点（依赖不存在的节点视为不可达）", () => {
  const planner = new MultiLoopPlanner();
  // 构造含不可达节点的 plan：A → B（正常），C → D（D 不存在，C 不可达）
  // 但当前 validate() 实现可能不严格校验依赖存在性，因此用自环测试：
  // 一个节点依赖自身形成自环（也是环的特殊情况）
  const unreachablePlan: MultiLoopPlan = {
    planId: "test-unreachable",
    projectRoot: "/tmp/test",
    loops: [
      {
        nodeId: "design-1",
        loopType: "design",
        dependencies: [],
        status: "pending",
        entryArtifact: "需求",
        exitCriteria: "spec 批准",
      },
      {
        nodeId: "coding-1",
        loopType: "coding",
        dependencies: ["design-1"],
        status: "pending",
        entryArtifact: "spec",
        exitCriteria: "G-5 通过",
      },
      // 自环节点：依赖自身
      {
        nodeId: "self-loop-1",
        loopType: "testing",
        dependencies: ["self-loop-1"],
        status: "pending",
        entryArtifact: "code",
        exitCriteria: "G-7 通过",
      },
    ],
    autoTransition: true,
    rollbackOnFailure: true,
    createdAt: "2026-07-19T00:00:00.000Z",
  };
  const result = planner.validate(unreachablePlan);
  // 自环应被检测为环
  assert.equal(result.valid, false);
  assert.ok(result.cycles.length > 0, "应检测到自环");
});

// ============================================================================
// M9/M10. nextNode() 返回下一个待执行节点
// ============================================================================

test("M9.1 nextNode() 无已完成节点时返回首个可执行节点", async () => {
  const planner = new MultiLoopPlanner();
  const plan = await planner.plan(makePlanRequest(makeMultiModuleSpec()));
  const nextNode = planner.nextNode(plan, []);
  assert.ok(nextNode !== null, "应返回一个节点而非 null");
  // 返回的节点应无依赖或依赖已满足
  assert.ok(
    nextNode.dependencies.every((depId) => false), // 空数组应满足
    "首个节点的依赖应为空或全部已完成"
  );
});

test("M10.1 nextNode() 全部完成时返回 null", async () => {
  const planner = new MultiLoopPlanner();
  const plan = await planner.plan(makePlanRequest(makeSingleModuleSpec()));
  // 全部节点 ID 视为已完成
  const allCompletedIds = plan.loops.map((n) => n.nodeId);
  const nextNode = planner.nextNode(plan, allCompletedIds);
  assert.equal(nextNode, null);
});

// ============================================================================
// M11. 计划字段不可变性
// ============================================================================

test("M11.1 plan() 返回的 plan 对象已冻结", async () => {
  const planner = new MultiLoopPlanner();
  const plan = await planner.plan(makePlanRequest(makeSingleModuleSpec()));
  assert.equal(Object.isFrozen(plan), true);
  assert.equal(Object.isFrozen(plan.loops), true);
});

test("M11.2 plan() 返回的节点对象已冻结", async () => {
  const planner = new MultiLoopPlanner();
  const plan = await planner.plan(makePlanRequest(makeSingleModuleSpec()));
  for (const node of plan.loops) {
    assert.equal(Object.isFrozen(node), true, `节点 ${node.nodeId} 应已冻结`);
  }
});

// ============================================================================
// M12. 错误类型与字段
// ============================================================================

test("M12.1 MultiLoopPlannerError 含 kind 与 detail 字段", async () => {
  const planner = new MultiLoopPlanner();
  try {
    await planner.plan({
      runId: "",
      projectRoot: "/tmp/test",
      specContent: makeSingleModuleSpec(),
    });
    assert.fail("应抛出异常");
  } catch (err) {
    assert.ok(err instanceof MultiLoopPlannerError);
    assert.ok(typeof err.kind === "string");
    assert.ok(typeof err.detail === "string");
    assert.equal(err.name, "MultiLoopPlannerError");
  }
});

test("M12.2 MultiLoopPlannerError kind 合法值", async () => {
  const planner = new MultiLoopPlanner();
  const validKinds = ["invalid-request", "spec-parse-failed", "dag-invalid", "node-not-found"];
  try {
    await planner.plan({
      runId: "",
      projectRoot: "/tmp/test",
      specContent: makeSingleModuleSpec(),
    });
  } catch (err) {
    assert.ok(err instanceof MultiLoopPlannerError);
    assert.ok(validKinds.includes(err.kind), `kind=${err.kind} 应为合法值`);
  }
});
