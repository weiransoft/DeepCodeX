/**
 * EAG-P1 批次 5 单元测试：任务分解 DAG + 拓扑排序 + 并行检测 + 循环依赖检测
 *
 * 测试范围：
 * - T1. decompose 基础功能
 *   - T1a. 空需求列表抛 empty-requirements
 *   - T1b. 1 条需求生成 5 个阶段任务
 *   - T1c. 2 条需求生成 10 个阶段任务
 *   - T1d. 任务 ID 格式为 T-NNN（三位补零）
 *   - T1e. 任务标题含中文阶段名
 * - T2. decompose 阶段依赖关系
 *   - T2a. skeleton 阶段无依赖
 *   - T2b. domain 阶段依赖 skeleton
 *   - T2c. service 阶段依赖 domain
 *   - T2d. api 阶段依赖 service
 *   - T2e. frontend 阶段依赖 api
 *   - T2f. 跨需求同阶段任务无依赖（可并行）
 * - T3. decompose 任务字段
 *   - T3a. fileCluster = requirement.module
 *   - T3b. requirementId 溯源正确
 *   - T3c. acceptanceCommand 格式为 npm test <module>-<phase>
 * - T4. decompose 返回冻结的 TaskDag
 *   - T4a. dag 对象已冻结
 *   - T4b. nodes 数组已冻结
 *   - T4c. 每个节点已冻结
 *   - T4d. topologicalOrder 已冻结
 * - T5. topologicalSort Kahn 算法
 *   - T5a. 空节点列表返回空数组
 *   - T5b. 单节点（无依赖）返回自身
 *   - T5c. 线性依赖链返回正确顺序
 *   - T5d. 同层节点按 ID 字典序排序（稳定）
 *   - T5e. 钻石依赖（A→B,C→D）返回合法拓扑序
 * - T6. detectParallelizable 按拓扑层级分组
 *   - T6a. 空节点列表返回空数组
 *   - T6b. level 0 含全部无依赖任务
 *   - T6c. 同层任务无依赖关系
 *   - T6d. 多层级分组正确
 *   - T6e. 返回结果已冻结（含内层数组）
 * - T7. validateDag 合法性校验
 *   - T7a. 合法 DAG 返回 valid=true
 *   - T7b. 检测循环依赖（cycles 非空）
 *   - T7c. 检测悬挂依赖（danglingDependencies 非空）
 *   - T7d. 检测重复 ID（duplicateIds 非空）
 *   - T7e. 返回结果已冻结
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止 mock，直接构造真实对象
 *
 * @module core/tests/eag-doc-driven-task-decomposition
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { TaskDecomposer, TaskDecompositionError } from "../eag/doc-driven/task-decomposition";
import type { DagValidationResult } from "../eag/doc-driven/task-decomposition";
import type { FunctionalRequirement, TaskNode } from "../eag/doc-driven/types";

// ============================================================================
// 辅助函数：构造测试用功能需求
// ============================================================================

/**
 * 构造测试用功能需求
 *
 * @param id 需求 ID（如 "F-001"）
 * @param title 需求标题
 * @param module 所属模块名
 * @returns FunctionalRequirement 对象
 */
function createTestRequirement(id: string, title: string, module: string): FunctionalRequirement {
  return {
    id,
    title,
    priority: "high",
    module,
    acceptanceCriteria: ["Given 前置条件，When 触发动作，Then 期望结果"],
  };
}

/**
 * 构造测试用任务节点（用于 topologicalSort / detectParallelizable / validateDag 测试）
 *
 * @param id 任务 ID
 * @param dependencies 依赖任务 ID 列表
 * @returns TaskNode 对象
 */
function createTestTask(id: string, dependencies: string[] = []): TaskNode {
  return {
    id,
    title: `测试任务 ${id}`,
    requirementId: "F-001",
    dependencies,
    fileCluster: "TestModule",
    acceptanceCommand: `npm test test-${id.toLowerCase()}`,
  };
}

// ============================================================================
// T1. decompose 基础功能
// ============================================================================

test("T1a. decompose 空需求列表抛 empty-requirements", () => {
  const decomposer = new TaskDecomposer();
  assert.throws(
    () => decomposer.decompose([]),
    (err: unknown) => {
      assert.ok(err instanceof TaskDecompositionError);
      assert.equal((err as TaskDecompositionError).kind, "empty-requirements");
      return true;
    }
  );
});

test("T1b. decompose 1 条需求生成 5 个阶段任务", () => {
  const decomposer = new TaskDecomposer();
  const dag = decomposer.decompose([createTestRequirement("F-001", "用户登录", "UserAggregate")]);
  assert.equal(dag.nodes.length, 5);
});

test("T1c. decompose 2 条需求生成 10 个阶段任务", () => {
  const decomposer = new TaskDecomposer();
  const dag = decomposer.decompose([
    createTestRequirement("F-001", "用户登录", "UserAggregate"),
    createTestRequirement("F-002", "订单创建", "OrderAggregate"),
  ]);
  assert.equal(dag.nodes.length, 10);
});

test("T1d. decompose 任务 ID 格式为 T-NNN（三位补零）", () => {
  const decomposer = new TaskDecomposer();
  const dag = decomposer.decompose([createTestRequirement("F-001", "用户登录", "UserAggregate")]);
  // 第一个任务 ID 应为 T-001
  assert.equal(dag.nodes[0].id, "T-001");
  // 第五个任务 ID 应为 T-005
  assert.equal(dag.nodes[4].id, "T-005");
});

test("T1e. decompose 任务标题含中文阶段名", () => {
  const decomposer = new TaskDecomposer();
  const dag = decomposer.decompose([createTestRequirement("F-001", "用户登录", "UserAggregate")]);
  // 验证 5 个阶段标题
  assert.ok(dag.nodes[0].title.includes("骨架"));
  assert.ok(dag.nodes[1].title.includes("领域实现"));
  assert.ok(dag.nodes[2].title.includes("应用服务"));
  assert.ok(dag.nodes[3].title.includes("API 接口"));
  assert.ok(dag.nodes[4].title.includes("前端"));
  // 标题含需求标题
  for (const node of dag.nodes) {
    assert.ok(node.title.includes("用户登录"));
  }
});

// ============================================================================
// T2. decompose 阶段依赖关系
// ============================================================================

test("T2a. skeleton 阶段无依赖", () => {
  const decomposer = new TaskDecomposer();
  const dag = decomposer.decompose([createTestRequirement("F-001", "用户登录", "UserAggregate")]);
  // T-001 是 skeleton 阶段，无依赖
  assert.equal(dag.nodes[0].dependencies.length, 0);
});

test("T2b. domain 阶段依赖 skeleton", () => {
  const decomposer = new TaskDecomposer();
  const dag = decomposer.decompose([createTestRequirement("F-001", "用户登录", "UserAggregate")]);
  // T-002 是 domain 阶段，依赖 T-001（skeleton）
  assert.equal(dag.nodes[1].dependencies.length, 1);
  assert.equal(dag.nodes[1].dependencies[0], "T-001");
});

test("T2c. service 阶段依赖 domain", () => {
  const decomposer = new TaskDecomposer();
  const dag = decomposer.decompose([createTestRequirement("F-001", "用户登录", "UserAggregate")]);
  // T-003 是 service 阶段，依赖 T-002（domain）
  assert.equal(dag.nodes[2].dependencies.length, 1);
  assert.equal(dag.nodes[2].dependencies[0], "T-002");
});

test("T2d. api 阶段依赖 service", () => {
  const decomposer = new TaskDecomposer();
  const dag = decomposer.decompose([createTestRequirement("F-001", "用户登录", "UserAggregate")]);
  // T-004 是 api 阶段，依赖 T-003（service）
  assert.equal(dag.nodes[3].dependencies.length, 1);
  assert.equal(dag.nodes[3].dependencies[0], "T-003");
});

test("T2e. frontend 阶段依赖 api", () => {
  const decomposer = new TaskDecomposer();
  const dag = decomposer.decompose([createTestRequirement("F-001", "用户登录", "UserAggregate")]);
  // T-005 是 frontend 阶段，依赖 T-004（api）
  assert.equal(dag.nodes[4].dependencies.length, 1);
  assert.equal(dag.nodes[4].dependencies[0], "T-004");
});

test("T2f. 跨需求同阶段任务无依赖（可并行）", () => {
  const decomposer = new TaskDecomposer();
  const dag = decomposer.decompose([
    createTestRequirement("F-001", "用户登录", "UserAggregate"),
    createTestRequirement("F-002", "订单创建", "OrderAggregate"),
  ]);
  // T-001（F-001 skeleton）与 T-006（F-002 skeleton）应都无依赖
  // 任务 ID 顺序：T-001~T-005 为 F-001，T-006~T-010 为 F-002
  const t001 = dag.nodes.find((n) => n.id === "T-001");
  const t006 = dag.nodes.find((n) => n.id === "T-006");
  assert.ok(t001);
  assert.ok(t006);
  assert.equal(t001.dependencies.length, 0);
  assert.equal(t006.dependencies.length, 0);
});

// ============================================================================
// T3. decompose 任务字段
// ============================================================================

test("T3a. decompose fileCluster = requirement.module", () => {
  const decomposer = new TaskDecomposer();
  const dag = decomposer.decompose([createTestRequirement("F-001", "用户登录", "UserAggregate")]);
  for (const node of dag.nodes) {
    assert.equal(node.fileCluster, "UserAggregate");
  }
});

test("T3b. decompose requirementId 溯源正确", () => {
  const decomposer = new TaskDecomposer();
  const dag = decomposer.decompose([
    createTestRequirement("F-001", "用户登录", "UserAggregate"),
    createTestRequirement("F-002", "订单创建", "OrderAggregate"),
  ]);
  // F-001 的任务（T-001~T-005）requirementId 应为 F-001
  const f001Tasks = dag.nodes.filter((n) => n.requirementId === "F-001");
  assert.equal(f001Tasks.length, 5);
  // F-002 的任务（T-006~T-010）requirementId 应为 F-002
  const f002Tasks = dag.nodes.filter((n) => n.requirementId === "F-002");
  assert.equal(f002Tasks.length, 5);
});

test("T3c. decompose acceptanceCommand 格式为 npm test <module>-<phase>", () => {
  const decomposer = new TaskDecomposer();
  const dag = decomposer.decompose([createTestRequirement("F-001", "用户登录", "UserAggregate")]);
  // 验证 5 个阶段的 acceptanceCommand
  assert.equal(dag.nodes[0].acceptanceCommand, "npm test useraggregate-skeleton");
  assert.equal(dag.nodes[1].acceptanceCommand, "npm test useraggregate-domain");
  assert.equal(dag.nodes[2].acceptanceCommand, "npm test useraggregate-service");
  assert.equal(dag.nodes[3].acceptanceCommand, "npm test useraggregate-api");
  assert.equal(dag.nodes[4].acceptanceCommand, "npm test useraggregate-frontend");
});

// ============================================================================
// T4. decompose 返回冻结的 TaskDag
// ============================================================================

test("T4a. decompose 返回的 dag 对象已冻结", () => {
  const decomposer = new TaskDecomposer();
  const dag = decomposer.decompose([createTestRequirement("F-001", "用户登录", "UserAggregate")]);
  assert.equal(Object.isFrozen(dag), true);
});

test("T4b. decompose nodes 数组已冻结", () => {
  const decomposer = new TaskDecomposer();
  const dag = decomposer.decompose([createTestRequirement("F-001", "用户登录", "UserAggregate")]);
  assert.equal(Object.isFrozen(dag.nodes), true);
});

test("T4c. decompose 每个节点已冻结", () => {
  const decomposer = new TaskDecomposer();
  const dag = decomposer.decompose([createTestRequirement("F-001", "用户登录", "UserAggregate")]);
  for (const node of dag.nodes) {
    assert.equal(Object.isFrozen(node), true);
  }
});

test("T4d. decompose topologicalOrder 已冻结", () => {
  const decomposer = new TaskDecomposer();
  const dag = decomposer.decompose([createTestRequirement("F-001", "用户登录", "UserAggregate")]);
  assert.equal(Object.isFrozen(dag.topologicalOrder), true);
});

// ============================================================================
// T5. topologicalSort Kahn 算法
// ============================================================================

test("T5a. topologicalSort 空节点列表返回空数组", () => {
  const decomposer = new TaskDecomposer();
  const result = decomposer.topologicalSort([]);
  assert.equal(result.length, 0);
});

test("T5b. topologicalSort 单节点（无依赖）返回自身", () => {
  const decomposer = new TaskDecomposer();
  const nodes = [createTestTask("T-001")];
  const result = decomposer.topologicalSort(nodes);
  assert.equal(result.length, 1);
  assert.equal(result[0], "T-001");
});

test("T5c. topologicalSort 线性依赖链返回正确顺序", () => {
  const decomposer = new TaskDecomposer();
  // T-003 → T-002 → T-001（T-003 依赖 T-002，T-002 依赖 T-001）
  const nodes = [createTestTask("T-003", ["T-002"]), createTestTask("T-002", ["T-001"]), createTestTask("T-001", [])];
  const result = decomposer.topologicalSort(nodes);
  assert.equal(result.length, 3);
  // T-001 必须在 T-002 之前，T-002 必须在 T-003 之前
  assert.equal(result[0], "T-001");
  assert.equal(result[1], "T-002");
  assert.equal(result[2], "T-003");
});

test("T5d. topologicalSort 同层节点按 ID 字典序排序（稳定）", () => {
  const decomposer = new TaskDecomposer();
  // 三个无依赖任务（同层），应按 ID 字典序排序
  const nodes = [createTestTask("T-003", []), createTestTask("T-001", []), createTestTask("T-002", [])];
  const result = decomposer.topologicalSort(nodes);
  assert.equal(result[0], "T-001");
  assert.equal(result[1], "T-002");
  assert.equal(result[2], "T-003");
});

test("T5e. topologicalSort 钻石依赖（A→B,C→D）返回合法拓扑序", () => {
  const decomposer = new TaskDecomposer();
  // 钻石依赖：T-001 → T-002, T-001 → T-003, T-002 → T-004, T-003 → T-004
  const nodes = [
    createTestTask("T-004", ["T-002", "T-003"]),
    createTestTask("T-003", ["T-001"]),
    createTestTask("T-002", ["T-001"]),
    createTestTask("T-001", []),
  ];
  const result = decomposer.topologicalSort(nodes);
  assert.equal(result.length, 4);
  // T-001 必须在最前
  assert.equal(result[0], "T-001");
  // T-004 必须在最后
  assert.equal(result[3], "T-004");
  // T-002 与 T-003 在中间，按字典序 T-002 < T-003
  assert.equal(result[1], "T-002");
  assert.equal(result[2], "T-003");
});

// ============================================================================
// T6. detectParallelizable 按拓扑层级分组
// ============================================================================

test("T6a. detectParallelizable 空节点列表返回空数组", () => {
  const decomposer = new TaskDecomposer();
  const result = decomposer.detectParallelizable([]);
  assert.equal(result.length, 0);
});

test("T6b. detectParallelizable level 0 含全部无依赖任务", () => {
  const decomposer = new TaskDecomposer();
  // 三个无依赖任务，应全部在 level 0
  const nodes = [createTestTask("T-001", []), createTestTask("T-002", []), createTestTask("T-003", [])];
  const result = decomposer.detectParallelizable(nodes);
  assert.equal(result.length, 1);
  assert.equal(result[0].length, 3);
  // level 0 含全部三个任务
  assert.ok(result[0].includes("T-001"));
  assert.ok(result[0].includes("T-002"));
  assert.ok(result[0].includes("T-003"));
});

test("T6c. detectParallelizable 同层任务无依赖关系", () => {
  const decomposer = new TaskDecomposer();
  // 钻石依赖：T-001 → T-002/T-003 → T-004
  // level 0: T-001
  // level 1: T-002, T-003（同层，无依赖关系）
  // level 2: T-004
  const nodes = [
    createTestTask("T-001", []),
    createTestTask("T-002", ["T-001"]),
    createTestTask("T-003", ["T-001"]),
    createTestTask("T-004", ["T-002", "T-003"]),
  ];
  const result = decomposer.detectParallelizable(nodes);
  assert.equal(result.length, 3);
  // level 1 含 T-002 与 T-003
  assert.equal(result[1].length, 2);
  assert.ok(result[1].includes("T-002"));
  assert.ok(result[1].includes("T-003"));
});

test("T6d. detectParallelizable 多层级分组正确", () => {
  const decomposer = new TaskDecomposer();
  // 线性依赖链：T-001 → T-002 → T-003 → T-004
  // 每层只有一个任务
  const nodes = [
    createTestTask("T-001", []),
    createTestTask("T-002", ["T-001"]),
    createTestTask("T-003", ["T-002"]),
    createTestTask("T-004", ["T-003"]),
  ];
  const result = decomposer.detectParallelizable(nodes);
  assert.equal(result.length, 4);
  // 每层一个任务
  assert.equal(result[0][0], "T-001");
  assert.equal(result[1][0], "T-002");
  assert.equal(result[2][0], "T-003");
  assert.equal(result[3][0], "T-004");
});

test("T6e. detectParallelizable 返回结果已冻结（含内层数组）", () => {
  const decomposer = new TaskDecomposer();
  const nodes = [createTestTask("T-001", []), createTestTask("T-002", ["T-001"])];
  const result = decomposer.detectParallelizable(nodes);
  // 外层数组已冻结
  assert.equal(Object.isFrozen(result), true);
  // 内层数组已冻结
  for (const group of result) {
    assert.equal(Object.isFrozen(group), true);
  }
});

// ============================================================================
// T7. validateDag 合法性校验
// ============================================================================

test("T7a. validateDag 合法 DAG 返回 valid=true", () => {
  const decomposer = new TaskDecomposer();
  // 钻石依赖：T-001 → T-002/T-003 → T-004
  const nodes = [
    createTestTask("T-001", []),
    createTestTask("T-002", ["T-001"]),
    createTestTask("T-003", ["T-001"]),
    createTestTask("T-004", ["T-002", "T-003"]),
  ];
  const result = decomposer.validateDag(nodes);
  assert.equal(result.valid, true);
  assert.equal(result.cycles.length, 0);
  assert.equal(result.danglingDependencies.length, 0);
  assert.equal(result.duplicateIds.length, 0);
});

test("T7b. validateDag 检测循环依赖（cycles 非空）", () => {
  const decomposer = new TaskDecomposer();
  // 循环依赖：T-001 → T-002 → T-001
  const nodes = [createTestTask("T-001", ["T-002"]), createTestTask("T-002", ["T-001"])];
  const result = decomposer.validateDag(nodes);
  assert.equal(result.valid, false);
  assert.ok(result.cycles.length > 0);
});

test("T7c. validateDag 检测悬挂依赖（danglingDependencies 非空）", () => {
  const decomposer = new TaskDecomposer();
  // T-001 依赖 T-999（不存在的任务）
  const nodes = [createTestTask("T-001", ["T-999"])];
  const result = decomposer.validateDag(nodes);
  assert.equal(result.valid, false);
  assert.ok(result.danglingDependencies.includes("T-999"));
});

test("T7d. validateDag 检测重复 ID（duplicateIds 非空）", () => {
  const decomposer = new TaskDecomposer();
  // 两个 T-001（重复 ID）
  const nodes = [createTestTask("T-001", []), createTestTask("T-001", [])];
  const result = decomposer.validateDag(nodes);
  assert.equal(result.valid, false);
  assert.ok(result.duplicateIds.includes("T-001"));
});

test("T7e. validateDag 返回结果已冻结", () => {
  const decomposer = new TaskDecomposer();
  const nodes = [createTestTask("T-001", [])];
  const result = decomposer.validateDag(nodes);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.cycles), true);
  assert.equal(Object.isFrozen(result.danglingDependencies), true);
  assert.equal(Object.isFrozen(result.duplicateIds), true);
});

// ============================================================================
// T8. DagValidationResult 接口字段完整性
// ============================================================================

test("T8. DagValidationResult 接口字段完整性——构造完整对象", () => {
  const result: DagValidationResult = {
    valid: true,
    cycles: [],
    danglingDependencies: [],
    duplicateIds: [],
  };
  assert.equal(result.valid, true);
  assert.equal(result.cycles.length, 0);
  assert.equal(result.danglingDependencies.length, 0);
  assert.equal(result.duplicateIds.length, 0);
});
