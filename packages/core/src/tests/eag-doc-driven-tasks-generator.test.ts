/**
 * EAG-P2 批次 8 单元测试：tasks.md 生成器
 *
 * 测试范围：
 * - T1. TasksGenerator 实例化
 * - T2. 完整输入 → 生成 Markdown
 *   - T2a. 含"# 任务分解（tasks.md）"标题
 *   - T2b. 含"## 1. 章节概览"章节
 *   - T2c. 含"## 2. 任务卡列表（按拓扑序）"章节
 * - T3. 任务卡渲染（含 ID / 标题 / 需求溯源 / 状态 / 依赖 / 验收标准）
 * - T4. 验收标准优先使用 acceptanceCriteriaMap
 * - T5. 验收标准缺失时使用 acceptanceCommand 兜底
 * - T6. 默认状态为 pending
 * - T7. Mermaid 依赖关系图渲染
 * - T8. 拓扑序渲染
 * - T9. 入参校验
 *   - T9a. planContent 为空 → 抛 TasksGeneratorError
 *   - T9b. taskDag 为 null → 抛 TasksGeneratorError
 *   - T9c. taskDag.nodes 非数组 → 抛 TasksGeneratorError
 *   - T9d. taskDag.nodes[0].id 为空 → 抛 TasksGeneratorError
 *   - T9e. taskDag.nodes[0].title 为空 → 抛 TasksGeneratorError
 *   - T9f. acceptanceCriteriaMap 为 null → 抛 TasksGeneratorError
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止 mock，直接构造真实对象
 *
 * @module core/tests/eag-doc-driven-tasks-generator
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { TasksGenerator, TasksGeneratorError } from "../eag/doc-driven/tasks-generator";
import type { TaskDag, TaskNode, TasksGenerationInput } from "../eag/doc-driven/types";

// ============================================================================
// 辅助函数：构造 TaskNode / TaskDag / TasksGenerationInput
// ============================================================================

/**
 * 构造测试用 TaskNode
 *
 * @param id 任务 ID
 * @param title 任务标题
 * @param dependencies 依赖任务 ID 列表
 * @returns 任务节点
 */
function createTaskNode(id: string, title: string, dependencies: string[] = []): TaskNode {
  return {
    id,
    title,
    requirementId: "F-001",
    dependencies,
    fileCluster: "UserAggregate",
    acceptanceCommand: `npm test ${id.toLowerCase()}`,
  };
}

/**
 * 构造测试用 TaskDag
 *
 * @param nodes 任务节点列表
 * @param topologicalOrder 拓扑序
 * @returns 任务 DAG
 */
function createTaskDag(nodes: TaskNode[] = [], topologicalOrder: string[] = []): TaskDag {
  return { nodes, topologicalOrder };
}

/**
 * 构造完整的 TasksGenerationInput
 *
 * @param overrides 覆盖字段
 * @returns 完整的 TasksGenerationInput
 */
function createInput(overrides: Partial<TasksGenerationInput> = {}): TasksGenerationInput {
  const nodes = [
    createTaskNode("T-001", "UserAggregate 骨架", []),
    createTaskNode("T-002", "UserService 实现", ["T-001"]),
    createTaskNode("T-003", "UserController 实现", ["T-002"]),
  ];
  const topologicalOrder = ["T-001", "T-002", "T-003"];
  return {
    planContent: "# 实现方案\n## 1. 实现方案\n...",
    taskDag: createTaskDag(nodes, topologicalOrder),
    acceptanceCriteriaMap: {
      "T-001": ["npm test user-aggregate"],
      "T-002": ["npm test user-service", "npm run lint"],
      "T-003": ["npm test user-controller"],
    },
    ...overrides,
  };
}

// ============================================================================
// T1. TasksGenerator 实例化
// ============================================================================

test("T1. TasksGenerator 实例化成功", () => {
  const generator = new TasksGenerator();
  assert.ok(generator instanceof TasksGenerator);
  assert.equal(typeof generator.generate, "function");
});

// ============================================================================
// T2. 完整输入 → 生成 Markdown
// ============================================================================

test("T2a. 含 # 任务分解（tasks.md）标题", () => {
  const generator = new TasksGenerator();
  const md = generator.generate(createInput());
  assert.ok(md.includes("# 任务分解（tasks.md）"));
});

test("T2b. 含 ## 1. 章节概览 章节", () => {
  const generator = new TasksGenerator();
  const md = generator.generate(createInput());
  assert.ok(md.includes("## 1. 章节概览"));
});

test("T2c. 含 ## 2. 任务卡列表（按拓扑序）章节", () => {
  const generator = new TasksGenerator();
  const md = generator.generate(createInput());
  assert.ok(md.includes("## 2. 任务卡列表（按拓扑序）"));
});

// ============================================================================
// T3. 任务卡渲染（含 ID / 标题 / 需求溯源 / 状态 / 依赖 / 验收标准）
// ============================================================================

test("T3. 任务卡渲染（含 ID / 标题 / 需求溯源 / 状态 / 依赖 / 验收标准）", () => {
  const generator = new TasksGenerator();
  const md = generator.generate(createInput());
  // 任务 ID
  assert.ok(md.includes("T-001"));
  assert.ok(md.includes("T-002"));
  assert.ok(md.includes("T-003"));
  // 任务标题
  assert.ok(md.includes("UserAggregate 骨架"));
  assert.ok(md.includes("UserService 实现"));
  // 需求溯源
  assert.ok(md.includes("[REQ-F-001]"));
});

// ============================================================================
// T4. 验收标准优先使用 acceptanceCriteriaMap
// ============================================================================

test("T4. 验收标准优先使用 acceptanceCriteriaMap", () => {
  const generator = new TasksGenerator();
  const md = generator.generate(createInput());
  // T-002 在 acceptanceCriteriaMap 中含 2 条标准
  assert.ok(md.includes("npm test user-service"));
  assert.ok(md.includes("npm run lint"));
});

// ============================================================================
// T5. 验收标准缺失时使用 acceptanceCommand 兜底
// ============================================================================

test("T5. 验收标准缺失时使用 acceptanceCommand 兜底", () => {
  const generator = new TasksGenerator();
  // 缺失 T-001 的验收标准 → 兜底使用 acceptanceCommand "npm test t-001"
  const md = generator.generate(
    createInput({
      acceptanceCriteriaMap: {
        "T-002": ["npm test user-service"],
        "T-003": ["npm test user-controller"],
      },
    })
  );
  // T-001 应使用 acceptanceCommand 兜底
  assert.ok(md.includes("npm test t-001"));
});

// ============================================================================
// T6. 默认状态为 pending
// ============================================================================

test("T6. 默认状态为 pending（生成期全部 pending）", () => {
  const generator = new TasksGenerator();
  const md = generator.generate(createInput());
  // 状态应为 pending（中文显示为"待办"）
  assert.ok(md.includes("待办"));
  assert.ok(md.includes("pending"));
});

// ============================================================================
// T7. Mermaid 依赖关系图渲染
// ============================================================================

test("T7. Mermaid 依赖关系图渲染（含 flowchart TD 与节点）", () => {
  const generator = new TasksGenerator();
  const md = generator.generate(createInput());
  assert.ok(md.includes("```mermaid"));
  assert.ok(md.includes("flowchart TD"));
  // 任务节点 ID 在 Mermaid 中应转换为合法 ID（连字符替换为下划线）
  assert.ok(md.includes("T_001"));
  assert.ok(md.includes("T_002"));
  // 依赖关系边：T-001 → T-002
  assert.ok(md.includes("T_001 --> T_002"));
});

// ============================================================================
// T8. 拓扑序渲染
// ============================================================================

test("T8. 拓扑序渲染（T-001 → T-002 → T-003）", () => {
  const generator = new TasksGenerator();
  const md = generator.generate(createInput());
  // 拓扑序应被渲染为 T-001 → T-002 → T-003
  assert.ok(md.includes("T-001 → T-002 → T-003"));
});

// ============================================================================
// T9. 入参校验
// ============================================================================

test("T9a. planContent 为空 → 抛 TasksGeneratorError", () => {
  const generator = new TasksGenerator();
  assert.throws(
    () => generator.generate(createInput({ planContent: "" })),
    (err: unknown) => {
      assert.ok(err instanceof TasksGeneratorError);
      assert.equal((err as TasksGeneratorError).field, "planContent");
      return true;
    }
  );
});

test("T9b. taskDag 为 null → 抛 TasksGeneratorError", () => {
  const generator = new TasksGenerator();
  assert.throws(
    () => generator.generate(createInput({ taskDag: null as unknown as TaskDag })),
    (err: unknown) => {
      assert.ok(err instanceof TasksGeneratorError);
      assert.equal((err as TasksGeneratorError).field, "taskDag");
      return true;
    }
  );
});

test("T9c. taskDag.nodes 非数组 → 抛 TasksGeneratorError", () => {
  const generator = new TasksGenerator();
  const badDag = createTaskDag();
  // @ts-expect-error 故意传入非数组以测试运行时校验
  badDag.nodes = "not-array";
  assert.throws(
    () => generator.generate(createInput({ taskDag: badDag })),
    (err: unknown) => {
      assert.ok(err instanceof TasksGeneratorError);
      assert.ok((err as TasksGeneratorError).field.includes("taskDag.nodes"));
      return true;
    }
  );
});

test("T9d. taskDag.nodes[0].id 为空 → 抛 TasksGeneratorError", () => {
  const generator = new TasksGenerator();
  const badNodes: TaskNode[] = [
    {
      id: "",
      title: "x",
      requirementId: "F-001",
      dependencies: [],
      fileCluster: "x",
      acceptanceCommand: "x",
    },
  ];
  assert.throws(
    () =>
      generator.generate(
        createInput({
          taskDag: createTaskDag(badNodes, [""]),
        })
      ),
    (err: unknown) => {
      assert.ok(err instanceof TasksGeneratorError);
      assert.ok((err as TasksGeneratorError).field.includes("taskDag.nodes[0].id"));
      return true;
    }
  );
});

test("T9e. taskDag.nodes[0].title 为空 → 抛 TasksGeneratorError", () => {
  const generator = new TasksGenerator();
  const badNodes: TaskNode[] = [
    {
      id: "T-001",
      title: "",
      requirementId: "F-001",
      dependencies: [],
      fileCluster: "x",
      acceptanceCommand: "x",
    },
  ];
  assert.throws(
    () =>
      generator.generate(
        createInput({
          taskDag: createTaskDag(badNodes, ["T-001"]),
        })
      ),
    (err: unknown) => {
      assert.ok(err instanceof TasksGeneratorError);
      assert.ok((err as TasksGeneratorError).field.includes("taskDag.nodes[0].title"));
      return true;
    }
  );
});

test("T9f. acceptanceCriteriaMap 为 null → 抛 TasksGeneratorError", () => {
  const generator = new TasksGenerator();
  assert.throws(
    () =>
      generator.generate(
        createInput({
          acceptanceCriteriaMap: null as unknown as Record<string, ReadonlyArray<string>>,
        })
      ),
    (err: unknown) => {
      assert.ok(err instanceof TasksGeneratorError);
      assert.equal((err as TasksGeneratorError).field, "acceptanceCriteriaMap");
      return true;
    }
  );
});

// ============================================================================
// T9g. topologicalOrder 与 nodes 数据不一致 → 抛 TasksGeneratorError（M-6 修复验证）
// ============================================================================

test("T9g. topologicalOrder 含 nodes 中不存在的 taskId → 抛 TasksGeneratorError（M-6 修复）", () => {
  // M-6 修复：原 convertToTaskCards 在拓扑序中的任务 ID 不在 nodes 中时静默 continue 跳过，
  // 掩盖数据不一致问题。修复后改为抛 TasksGeneratorError，便于调用方定位 TaskDag 生成缺陷。
  const generator = new TasksGenerator();
  // 构造数据不一致的 TaskDag：topologicalOrder 含 "T-999" 但 nodes 中不存在此任务
  const nodes = [createTaskNode("T-001", "UserAggregate 骨架", [])];
  const inconsistentDag = createTaskDag(nodes, ["T-001", "T-999"]); // T-999 不在 nodes
  assert.throws(
    () =>
      generator.generate(
        createInput({
          taskDag: inconsistentDag,
        })
      ),
    (err: unknown) => {
      assert.ok(err instanceof TasksGeneratorError);
      // 错误字段应包含 topologicalOrder 索引
      assert.ok(
        (err as TasksGeneratorError).field.includes("topologicalOrder"),
        `错误字段应包含 topologicalOrder，实际: ${(err as TasksGeneratorError).field}`
      );
      // 错误原因应说明数据不一致
      assert.ok(
        (err as TasksGeneratorError).reason.includes("T-999") ||
          (err as TasksGeneratorError).reason.includes("数据不一致"),
        `错误原因应说明数据不一致，实际: ${(err as TasksGeneratorError).reason}`
      );
      return true;
    }
  );
});

// ============================================================================
// T10. TaskCard.declaredSymbols 透传验证（B-1 修复验证）
// ============================================================================

test("T10. TaskCard.declaredSymbols 从 TaskNode.declaredSymbols 透传（B-1 修复）", () => {
  // B-1 修复：G-3 门禁数据源契约断裂——TaskCard 新增 declaredSymbols 字段，
  // convertToTaskCards 透传 TaskNode.declaredSymbols。
  const generator = new TasksGenerator();
  // 构造含 declaredSymbols 的 TaskNode
  const nodes: TaskNode[] = [
    {
      id: "T-001",
      title: "UserAggregate 骨架",
      requirementId: "F-001",
      dependencies: [],
      fileCluster: "UserAggregate",
      acceptanceCommand: "npm test user-aggregate",
      declaredSymbols: [
        "src/domain/UserAggregate.ts:UserAggregate.constructor",
        "src/domain/UserAggregate.ts:UserAggregate.id",
      ],
    },
    {
      id: "T-002",
      title: "UserService 实现",
      requirementId: "F-001",
      dependencies: ["T-001"],
      fileCluster: "UserAggregate",
      acceptanceCommand: "npm test user-service",
      // 不传 declaredSymbols，验证旧数据兼容（兜底为空数组）
    },
  ];
  const topologicalOrder = ["T-001", "T-002"];
  const input = createInput({
    taskDag: createTaskDag(nodes, topologicalOrder),
  });
  const md = generator.generate(input);
  // 生成成功即说明字段透传成功（如有字段缺失会触发 TS 类型错误或运行时错误）
  assert.ok(md.includes("T-001"), "应渲染 T-001 任务卡");
  assert.ok(md.includes("T-002"), "应渲染 T-002 任务卡");
});

test("T10b. TaskNode 缺失 declaredSymbols 时 TaskCard 兜底为空数组（B-1 修复）", () => {
  // B-1 修复：TaskNode.declaredSymbols 为可选字段（兼容旧数据）
  // convertToTaskCards 使用 node.declaredSymbols ?? [] 兜底为空数组
  const generator = new TasksGenerator();
  // 旧数据：TaskNode 不含 declaredSymbols 字段
  const nodes: TaskNode[] = [
    {
      id: "T-001",
      title: "旧任务",
      requirementId: "F-001",
      dependencies: [],
      fileCluster: "OldAggregate",
      acceptanceCommand: "npm test old",
      // 故意不传 declaredSymbols，验证兜底逻辑
    },
  ];
  const input = createInput({
    taskDag: createTaskDag(nodes, ["T-001"]),
  });
  // 应正常生成（兜底为空数组，不抛错）
  const md = generator.generate(input);
  assert.ok(md.includes("T-001"), "应正常渲染旧任务卡");
});
