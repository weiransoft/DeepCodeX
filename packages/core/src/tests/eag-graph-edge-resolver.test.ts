/**
 * EAG-Graph EdgeResolver 单元测试（Phase 2）
 *
 * 测试范围：
 * - E1. "output." 前缀路径解析（从 sourceOutput 取值）
 * - E2. "$state." 前缀路径解析（从 globalState 取值）
 * - E3. 无前缀路径解析（直接从 sourceOutput 取值）
 * - E4. 多级点号路径解析（如 "output.result.score"）
 * - E5. 多边合并（merge 场景，多条边 dataMapping 合并）
 * - E6. required 字段缺失且无 defaultValue → 抛出
 * - E7. required 字段缺失但有 defaultValue → 填充默认值
 * - E8. 非必填字段缺失且无 defaultValue → 忽略该字段
 * - E9. 字段类型校验：string / number / boolean / object / array / any
 * - E10. 字段类型不匹配 → 抛出
 * - E11. 路径中断返回 undefined（中间层级为 null/非对象）
 * - E12. 返回冻结的输入数据（Object.isFrozen）
 * - E13. createEdgeResolver 工厂函数
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止使用 mock 框架，使用真实类型实例和真实函数调用
 * - 每个测试用例独立，无共享可变状态
 *
 * 设计依据：
 * - LOOP-GRAPH-FUSION-DESIGN.md §7.3 dataMapping 定义 / §8.2 EdgeResolverProtocol
 * - eag/graph/graph-edge-resolver.ts 源文件（被测对象）
 *
 * @module core/tests/eag-graph-edge-resolver
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { EdgeResolverImpl, createEdgeResolver } from "../eag/graph/graph-edge-resolver";
import type { GraphEdgeDef, GraphNodeDef, NodeFieldContract } from "../eag/graph/graph-loop-models";
import type { EdgeResolverProtocol } from "../eag/graph/graph-loop-protocols";

// ============================================================================
// 辅助：构造测试数据
// ============================================================================

/**
 * 构造一条边定义
 *
 * @param edgeId 边 ID
 * @param from 源节点 ID
 * @param to 目标节点 ID
 * @param dataMapping 数据映射
 */
function makeEdge(edgeId: string, from: string, to: string, dataMapping: Record<string, string>): GraphEdgeDef {
  return { edgeId, from, to, dataMapping };
}

/**
 * 构造目标节点定义（含 inputContract）
 *
 * @param nodeId 节点 ID
 * @param inputContract 输入契约
 */
function makeTargetNode(nodeId: string, inputContract: NodeFieldContract[]): GraphNodeDef {
  return {
    nodeId,
    nodeType: "task",
    label: nodeId,
    task: `${nodeId} 任务`,
    inputContract,
    outputContract: [],
    plugin: "echo",
  };
}

/**
 * 构造一个 passed 的验证结果（用于 NodeLoopKernel 测试辅助，此处不使用）
 */
// 注意：此处不构造 LoopEvaluationVerdict，EdgeResolver 不依赖它

// ============================================================================
// E1. "output." 前缀路径解析
// ============================================================================

test("E1. dataMapping value 以 'output.' 前缀时从 sourceOutput 取值", () => {
  const resolver = new EdgeResolverImpl();
  const edges: GraphEdgeDef[] = [makeEdge("e1", "src", "tgt", { designDoc: "output.designDoc" })];
  const sourceOutput = { designDoc: "设计文档内容" };
  const targetNode = makeTargetNode("tgt", [{ name: "designDoc", type: "string", required: true }]);

  const input = resolver.resolve(edges, sourceOutput, targetNode, {});

  assert.equal(input.designDoc, "设计文档内容", "应从 sourceOutput 取值");
});

// ============================================================================
// E2. "$state." 前缀路径解析
// ============================================================================

test("E2. dataMapping value 以 '$state.' 前缀时从 globalState 取值", () => {
  const resolver = new EdgeResolverImpl();
  const edges: GraphEdgeDef[] = [makeEdge("e1", "src", "tgt", { userId: "$state.userId" })];
  const sourceOutput = {};
  const globalState = { userId: "user-001" };
  const targetNode = makeTargetNode("tgt", [{ name: "userId", type: "string", required: true }]);

  const input = resolver.resolve(edges, sourceOutput, targetNode, globalState);

  assert.equal(input.userId, "user-001", "应从 globalState 取值");
});

// ============================================================================
// E3. 无前缀路径解析（直接从 sourceOutput 取值）
// ============================================================================

test("E3. dataMapping value 无前缀时直接从 sourceOutput 取值", () => {
  const resolver = new EdgeResolverImpl();
  const edges: GraphEdgeDef[] = [makeEdge("e1", "src", "tgt", { apiSpec: "apiSpec" })];
  const sourceOutput = { apiSpec: { endpoints: ["/api/v1"] } };
  const targetNode = makeTargetNode("tgt", [{ name: "apiSpec", type: "object", required: true }]);

  const input = resolver.resolve(edges, sourceOutput, targetNode, {});

  assert.deepEqual(input.apiSpec, { endpoints: ["/api/v1"] }, "应直接从 sourceOutput 取值");
});

// ============================================================================
// E4. 多级点号路径解析
// ============================================================================

test("E4. dataMapping value 支持多级点号路径（output.result.score）", () => {
  const resolver = new EdgeResolverImpl();
  const edges: GraphEdgeDef[] = [makeEdge("e1", "src", "tgt", { score: "output.result.score" })];
  const sourceOutput = {
    result: {
      score: 95,
      level: "A",
    },
  };
  const targetNode = makeTargetNode("tgt", [{ name: "score", type: "number", required: true }]);

  const input = resolver.resolve(edges, sourceOutput, targetNode, {});

  assert.equal(input.score, 95, "应正确解析多级路径");
});

test("E4b. dataMapping value 支持多级点号路径（$state.config.timeout）", () => {
  const resolver = new EdgeResolverImpl();
  const edges: GraphEdgeDef[] = [makeEdge("e1", "src", "tgt", { timeout: "$state.config.timeout" })];
  const sourceOutput = {};
  const globalState = {
    config: { timeout: 30 },
  };
  const targetNode = makeTargetNode("tgt", [{ name: "timeout", type: "number", required: true }]);

  const input = resolver.resolve(edges, sourceOutput, targetNode, globalState);

  assert.equal(input.timeout, 30, "应正确解析 $state 多级路径");
});

test("E4c. dataMapping value 支持多级点号路径（无前缀 result.score）", () => {
  const resolver = new EdgeResolverImpl();
  const edges: GraphEdgeDef[] = [makeEdge("e1", "src", "tgt", { score: "result.score" })];
  const sourceOutput = { result: { score: 88 } };
  const targetNode = makeTargetNode("tgt", [{ name: "score", type: "number", required: true }]);

  const input = resolver.resolve(edges, sourceOutput, targetNode, {});

  assert.equal(input.score, 88, "应正确解析无前缀多级路径");
});

// ============================================================================
// E5. 多边合并（merge 场景）
// ============================================================================

test("E5. 多条边的 dataMapping 合并到同一输入对象", () => {
  const resolver = new EdgeResolverImpl();
  const edges: GraphEdgeDef[] = [
    makeEdge("e1", "branchA", "merge", { fieldA: "output.fieldA" }),
    makeEdge("e2", "branchB", "merge", { fieldB: "output.fieldB" }),
  ];
  // merge 场景下 sourceOutput 是合并后的对象（包含两个分支的输出）
  const sourceOutput = { fieldA: "来自分支A", fieldB: "来自分支B" };
  const targetNode = makeTargetNode("merge", [
    { name: "fieldA", type: "string", required: true },
    { name: "fieldB", type: "string", required: true },
  ]);

  const input = resolver.resolve(edges, sourceOutput, targetNode, {});

  assert.equal(input.fieldA, "来自分支A");
  assert.equal(input.fieldB, "来自分支B");
});

// ============================================================================
// E6. required 字段缺失且无 defaultValue → 抛出
// ============================================================================

test("E6. required 字段无法解析且无 defaultValue 时抛出", () => {
  const resolver = new EdgeResolverImpl();
  const edges: GraphEdgeDef[] = [
    makeEdge("e1", "src", "tgt", { existing: "output.existing" }),
    // missing 字段未在 dataMapping 中声明，且为 required
  ];
  const sourceOutput = { existing: "存在" };
  const targetNode = makeTargetNode("tgt", [
    { name: "existing", type: "string", required: true },
    { name: "missing", type: "string", required: true },
  ]);

  assert.throws(
    () => resolver.resolve(edges, sourceOutput, targetNode, {}),
    /必填输入字段 "missing" 无法解析/,
    "required 字段缺失且无 defaultValue 时应抛出"
  );
});

// ============================================================================
// E7. required 字段缺失但有 defaultValue → 填充默认值
// ============================================================================

test("E7. required 字段无法解析但有 defaultValue 时填充默认值", () => {
  const resolver = new EdgeResolverImpl();
  const edges: GraphEdgeDef[] = [
    makeEdge("e1", "src", "tgt", { provided: "output.provided" }),
    // defaultField 未在 dataMapping 中声明，但有 defaultValue
  ];
  const sourceOutput = { provided: "已提供" };
  const targetNode = makeTargetNode("tgt", [
    { name: "provided", type: "string", required: true },
    { name: "defaultField", type: "number", required: true, defaultValue: 100 },
  ]);

  const input = resolver.resolve(edges, sourceOutput, targetNode, {});

  assert.equal(input.provided, "已提供");
  assert.equal(input.defaultField, 100, "应填充 defaultValue");
});

// ============================================================================
// E8. 非必填字段缺失且无 defaultValue → 忽略该字段
// ============================================================================

test("E8. 非必填字段缺失且无 defaultValue 时忽略该字段", () => {
  const resolver = new EdgeResolverImpl();
  const edges: GraphEdgeDef[] = [makeEdge("e1", "src", "tgt", { provided: "output.provided" })];
  const sourceOutput = { provided: "已提供" };
  const targetNode = makeTargetNode("tgt", [
    { name: "provided", type: "string", required: true },
    { name: "optional", type: "string", required: false },
  ]);

  const input = resolver.resolve(edges, sourceOutput, targetNode, {});

  assert.equal(input.provided, "已提供");
  assert.equal(
    Object.prototype.hasOwnProperty.call(input, "optional"),
    false,
    "非必填字段缺失且无 defaultValue 时不应写入 input"
  );
});

// ============================================================================
// E9. 字段类型校验：string / number / boolean / object / array / any
// ============================================================================

test("E9a. string 类型校验通过", () => {
  const resolver = new EdgeResolverImpl();
  const edges: GraphEdgeDef[] = [makeEdge("e1", "src", "tgt", { name: "output.name" })];
  const sourceOutput = { name: "hello" };
  const targetNode = makeTargetNode("tgt", [{ name: "name", type: "string", required: true }]);

  const input = resolver.resolve(edges, sourceOutput, targetNode, {});
  assert.equal(input.name, "hello");
});

test("E9b. number 类型校验通过", () => {
  const resolver = new EdgeResolverImpl();
  const edges: GraphEdgeDef[] = [makeEdge("e1", "src", "tgt", { count: "output.count" })];
  const sourceOutput = { count: 42 };
  const targetNode = makeTargetNode("tgt", [{ name: "count", type: "number", required: true }]);

  const input = resolver.resolve(edges, sourceOutput, targetNode, {});
  assert.equal(input.count, 42);
});

test("E9c. boolean 类型校验通过", () => {
  const resolver = new EdgeResolverImpl();
  const edges: GraphEdgeDef[] = [makeEdge("e1", "src", "tgt", { flag: "output.flag" })];
  const sourceOutput = { flag: true };
  const targetNode = makeTargetNode("tgt", [{ name: "flag", type: "boolean", required: true }]);

  const input = resolver.resolve(edges, sourceOutput, targetNode, {});
  assert.equal(input.flag, true);
});

test("E9d. object 类型校验通过", () => {
  const resolver = new EdgeResolverImpl();
  const edges: GraphEdgeDef[] = [makeEdge("e1", "src", "tgt", { data: "output.data" })];
  const sourceOutput = { data: { key: "value" } };
  const targetNode = makeTargetNode("tgt", [{ name: "data", type: "object", required: true }]);

  const input = resolver.resolve(edges, sourceOutput, targetNode, {});
  assert.deepEqual(input.data, { key: "value" });
});

test("E9e. array 类型校验通过", () => {
  const resolver = new EdgeResolverImpl();
  const edges: GraphEdgeDef[] = [makeEdge("e1", "src", "tgt", { items: "output.items" })];
  const sourceOutput = { items: [1, 2, 3] };
  const targetNode = makeTargetNode("tgt", [{ name: "items", type: "array", required: true }]);

  const input = resolver.resolve(edges, sourceOutput, targetNode, {});
  assert.deepEqual(input.items, [1, 2, 3]);
});

test("E9f. any 类型不校验（接受任意类型）", () => {
  const resolver = new EdgeResolverImpl();
  const edges: GraphEdgeDef[] = [makeEdge("e1", "src", "tgt", { value: "output.value" })];
  const sourceOutput = { value: 12345 };
  const targetNode = makeTargetNode("tgt", [{ name: "value", type: "any", required: true }]);

  const input = resolver.resolve(edges, sourceOutput, targetNode, {});
  assert.equal(input.value, 12345, "any 类型应接受任意值");
});

// ============================================================================
// E10. 字段类型不匹配 → 抛出
// ============================================================================

test("E10a. 期望 string 但实际 number 时抛出", () => {
  const resolver = new EdgeResolverImpl();
  const edges: GraphEdgeDef[] = [makeEdge("e1", "src", "tgt", { name: "output.name" })];
  const sourceOutput = { name: 12345 };
  const targetNode = makeTargetNode("tgt", [{ name: "name", type: "string", required: true }]);

  assert.throws(
    () => resolver.resolve(edges, sourceOutput, targetNode, {}),
    /类型不匹配.*期望=string.*实际=number/,
    "类型不匹配时应抛出"
  );
});

test("E10b. 期望 array 但实际 object 时抛出", () => {
  const resolver = new EdgeResolverImpl();
  const edges: GraphEdgeDef[] = [makeEdge("e1", "src", "tgt", { items: "output.items" })];
  const sourceOutput = { items: { not: "array" } };
  const targetNode = makeTargetNode("tgt", [{ name: "items", type: "array", required: true }]);

  assert.throws(
    () => resolver.resolve(edges, sourceOutput, targetNode, {}),
    /类型不匹配.*期望=array.*实际=object/,
    "类型不匹配时应抛出"
  );
});

test("E10c. 期望 object 但实际 null 时抛出", () => {
  const resolver = new EdgeResolverImpl();
  const edges: GraphEdgeDef[] = [makeEdge("e1", "src", "tgt", { data: "output.data" })];
  const sourceOutput = { data: null };
  const targetNode = makeTargetNode("tgt", [{ name: "data", type: "object", required: true }]);

  assert.throws(
    () => resolver.resolve(edges, sourceOutput, targetNode, {}),
    /类型不匹配.*期望=object.*实际=null/,
    "null 不应匹配 object 类型"
  );
});

// ============================================================================
// E11. 路径中断返回 undefined
// ============================================================================

test("E11a. 多级路径中间层级为 null 时该字段不写入 input", () => {
  const resolver = new EdgeResolverImpl();
  const edges: GraphEdgeDef[] = [makeEdge("e1", "src", "tgt", { score: "output.result.score" })];
  const sourceOutput = { result: null };
  const targetNode = makeTargetNode("tgt", [{ name: "score", type: "number", required: false }]);

  const input = resolver.resolve(edges, sourceOutput, targetNode, {});
  assert.equal(Object.prototype.hasOwnProperty.call(input, "score"), false, "路径中断时该字段不应写入 input");
});

test("E11b. 多级路径中间层级为非对象时该字段不写入 input", () => {
  const resolver = new EdgeResolverImpl();
  const edges: GraphEdgeDef[] = [makeEdge("e1", "src", "tgt", { score: "output.result.score" })];
  // result 是字符串，无法继续取 .score
  const sourceOutput = { result: "not-an-object" };
  const targetNode = makeTargetNode("tgt", [{ name: "score", type: "number", required: false }]);

  const input = resolver.resolve(edges, sourceOutput, targetNode, {});
  assert.equal(Object.prototype.hasOwnProperty.call(input, "score"), false, "路径中断时该字段不应写入 input");
});

// ============================================================================
// E12. 返回冻结的输入数据
// ============================================================================

test("E12. resolve() 返回冻结的输入数据（Object.isFrozen=true）", () => {
  const resolver = new EdgeResolverImpl();
  const edges: GraphEdgeDef[] = [makeEdge("e1", "src", "tgt", { name: "output.name" })];
  const sourceOutput = { name: "hello" };
  const targetNode = makeTargetNode("tgt", [{ name: "name", type: "string", required: true }]);

  const input = resolver.resolve(edges, sourceOutput, targetNode, {});
  assert.equal(Object.isFrozen(input), true, "返回的输入数据应被冻结");
});

// ============================================================================
// E13. createEdgeResolver 工厂函数
// ============================================================================

test("E13. createEdgeResolver() 返回 EdgeResolverProtocol 实例", () => {
  const resolver = createEdgeResolver();
  assert.ok(resolver, "工厂函数应返回非空实例");
  assert.equal(typeof resolver.resolve, "function", "实例应有 resolve 方法");
});

test("E13b. createEdgeResolver() 返回的实例可正常工作", () => {
  const resolver: EdgeResolverProtocol = createEdgeResolver();
  const edges: GraphEdgeDef[] = [makeEdge("e1", "src", "tgt", { value: "output.value" })];
  const sourceOutput = { value: "test-value" };
  const targetNode = makeTargetNode("tgt", [{ name: "value", type: "string", required: true }]);

  const input = resolver.resolve(edges, sourceOutput, targetNode, {});
  assert.equal(input.value, "test-value", "工厂函数创建的实例应正常工作");
});

// ============================================================================
// E14. 空边列表 + 空契约（边界场景）
// ============================================================================

test("E14. 空边列表 + 空契约时返回空对象", () => {
  const resolver = new EdgeResolverImpl();
  const edges: GraphEdgeDef[] = [];
  const sourceOutput = {};
  const targetNode = makeTargetNode("tgt", []);

  const input = resolver.resolve(edges, sourceOutput, targetNode, {});
  assert.equal(Object.keys(input).length, 0, "空边列表 + 空契约时应返回空对象");
});

// ============================================================================
// E15. dataMapping 中声明的字段不在 inputContract 中（多余字段保留）
// ============================================================================

test("E15. dataMapping 映射的字段不在 inputContract 中时仍保留在输入中", () => {
  const resolver = new EdgeResolverImpl();
  const edges: GraphEdgeDef[] = [
    makeEdge("e1", "src", "tgt", {
      declared: "output.declared",
      extra: "output.extra",
    }),
  ];
  const sourceOutput = { declared: "声明字段", extra: "额外字段" };
  const targetNode = makeTargetNode("tgt", [
    { name: "declared", type: "string", required: true },
    // inputContract 中未声明 extra 字段
  ]);

  const input = resolver.resolve(edges, sourceOutput, targetNode, {});
  assert.equal(input.declared, "声明字段");
  // extra 字段虽不在 inputContract 中，但 dataMapping 已映射，应保留
  assert.equal(input.extra, "额外字段", "dataMapping 映射的字段应保留在输入中");
});
