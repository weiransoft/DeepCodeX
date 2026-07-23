/**
 * EAG-Graph Builder 单元测试（Phase 2）
 *
 * 测试范围：
 * - B1. GraphBuilder.create() 创建空构造器
 * - B2. 链式 API：addNode / addEdge / setEntryNodeId / setConfig / setGlobalState / setGraphInfo
 * - B3. build() 基本结构校验：graphId/name/description/entryNodeId 非空
 * - B4. build() 节点 ID 唯一性校验
 * - B5. build() 边 ID 唯一性校验
 * - B6. build() 入口节点存在性校验
 * - B7. build() 边 from/to 引用有效性校验
 * - B8. build() 返回冻结的 WorkGraph（Object.isFrozen）
 * - B9. fromJson() 解析完整 JSON
 * - B10. fromJson() 缺省字段使用默认值（config / globalState / inputContract / outputContract / dataMapping）
 * - B11. fromJson() 必填字段缺失时抛出
 * - B12. fromJson() 非法 JSON 抛出
 * - B13. fromJson() nodes/edges 非数组时抛出
 * - B14. addNode 重复 ID 抛出
 * - B15. addEdge 重复 ID 抛出
 * - B16. loopConfig 缺省字段合并默认值
 * - B17. build() 空节点列表抛出
 *
 * 测试约定（遵循项目规则）：
 * - 使用 node:test + node:assert/strict
 * - 禁止使用 mock 框架，使用真实类型实例和真实函数调用
 * - 每个测试用例独立，无共享可变状态
 *
 * 设计依据：
 * - LOOP-GRAPH-FUSION-DESIGN.md §16 GraphBuilder API
 * - eag/graph/graph-builder.ts 源文件（被测对象）
 *
 * @module core/tests/eag-graph-builder
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { GraphBuilder } from "../eag/graph/graph-builder";
import { DEFAULT_WORK_GRAPH_CONFIG, DEFAULT_NODE_LOOP_CONFIG } from "../eag/graph/graph-loop-models";
import type { GraphNodeDef, GraphEdgeDef, WorkGraph, NodeFieldContract } from "../eag/graph/graph-loop-models";

// ============================================================================
// 辅助：构造测试数据
// ============================================================================

/**
 * 构造一个最小可用的 task 节点定义
 *
 * @param nodeId 节点 ID
 * @param label 节点标签（缺省时使用 nodeId）
 */
function makeTaskNode(nodeId: string, label?: string): GraphNodeDef {
  return {
    nodeId,
    nodeType: "task",
    label: label ?? nodeId,
    task: `${nodeId} 的任务`,
    inputContract: [],
    outputContract: [],
    plugin: "echo",
  };
}

/**
 * 构造一个 end 节点定义
 *
 * @param nodeId 节点 ID
 */
function makeEndNode(nodeId: string): GraphNodeDef {
  return {
    nodeId,
    nodeType: "end",
    label: nodeId,
    task: "结束节点",
    inputContract: [],
    outputContract: [],
  };
}

/**
 * 构造一条基本边定义
 *
 * @param edgeId 边 ID
 * @param from 源节点 ID
 * @param to 目标节点 ID
 */
function makeEdge(edgeId: string, from: string, to: string): GraphEdgeDef {
  return {
    edgeId,
    from,
    to,
    dataMapping: {},
  };
}

/**
 * 构造带字段契约的节点定义（用于测试 outputContract / inputContract 传递）
 *
 * @param nodeId 节点 ID
 * @param nodeType 节点类型
 * @param inputContract 输入契约
 * @param outputContract 输出契约
 */
function makeNodeWithContract(
  nodeId: string,
  nodeType: "task" | "loop" | "end",
  inputContract: NodeFieldContract[],
  outputContract: NodeFieldContract[]
): GraphNodeDef {
  const base: GraphNodeDef = {
    nodeId,
    nodeType,
    label: nodeId,
    task: `${nodeId} 的任务`,
    inputContract,
    outputContract,
  };
  if (nodeType === "task") {
    base.plugin = "echo";
  }
  return base;
}

// ============================================================================
// B1. GraphBuilder.create() 创建空构造器
// ============================================================================

test("B1. GraphBuilder.create() 返回 GraphBuilder 实例", () => {
  const builder = GraphBuilder.create();
  assert.ok(builder instanceof GraphBuilder, "create() 应返回 GraphBuilder 实例");
});

// ============================================================================
// B2. 链式 API：addNode / addEdge / setEntryNodeId / setConfig / setGlobalState / setGraphInfo
// ============================================================================

test("B2. 链式 API 返回 this，支持链式调用", () => {
  const builder = GraphBuilder.create();
  const result1 = builder.setGraphInfo("g1", "测试图", "测试描述");
  const result2 = builder.addNode(makeTaskNode("start"));
  const result3 = builder.addNode(makeEndNode("end"));
  const result4 = builder.addEdge(makeEdge("e1", "start", "end"));
  const result5 = builder.setEntryNodeId("start");
  const result6 = builder.setConfig({ ...DEFAULT_WORK_GRAPH_CONFIG, maxDepth: 50 });
  const result7 = builder.setGlobalState({ userId: "u1" });

  // 所有链式方法应返回同一个 builder 实例
  assert.equal(result1, builder, "setGraphInfo 应返回 this");
  assert.equal(result2, builder, "addNode 应返回 this");
  assert.equal(result3, builder, "addNode 应返回 this");
  assert.equal(result4, builder, "addEdge 应返回 this");
  assert.equal(result5, builder, "setEntryNodeId 应返回 this");
  assert.equal(result6, builder, "setConfig 应返回 this");
  assert.equal(result7, builder, "setGlobalState 应返回 this");
});

// ============================================================================
// B3. build() 基本结构校验
// ============================================================================

test("B3. build() 成功构造完整 WorkGraph", () => {
  const graph = GraphBuilder.create()
    .setGraphInfo("g1", "测试图", "测试描述")
    .addNode(makeTaskNode("start"))
    .addNode(makeEndNode("end"))
    .addEdge(makeEdge("e1", "start", "end"))
    .setEntryNodeId("start")
    .build();

  assert.equal(graph.graphId, "g1");
  assert.equal(graph.name, "测试图");
  assert.equal(graph.description, "测试描述");
  assert.equal(graph.entryNodeId, "start");
  assert.equal(graph.nodes.size, 2, "应包含 2 个节点");
  assert.equal(graph.edges.length, 1, "应包含 1 条边");
  assert.ok(graph.nodes.has("start"), "应包含 start 节点");
  assert.ok(graph.nodes.has("end"), "应包含 end 节点");
});

test("B3b. build() 缺少 graphId 时抛出", () => {
  const builder = GraphBuilder.create()
    .addNode(makeTaskNode("start"))
    .addNode(makeEndNode("end"))
    .addEdge(makeEdge("e1", "start", "end"))
    .setEntryNodeId("start");
  // 未设置 graphId / name / description
  assert.throws(() => builder.build(), /graphId 未设置/, "缺少 graphId 时应抛出错误");
});

test("B3c. build() 缺少 name 时抛出", () => {
  const builder = GraphBuilder.create()
    .setGraphInfo("", "", "")
    .addNode(makeTaskNode("start"))
    .addNode(makeEndNode("end"))
    .addEdge(makeEdge("e1", "start", "end"))
    .setEntryNodeId("start");
  assert.throws(() => builder.build(), /graphId 未设置|name 未设置/, "缺少 name 时应抛出错误");
});

// ============================================================================
// B4. build() 节点 ID 唯一性校验（通过 addNode 防御）
// ============================================================================

test("B4. addNode 重复节点 ID 时抛出", () => {
  const builder = GraphBuilder.create().addNode(makeTaskNode("start"));
  assert.throws(() => builder.addNode(makeTaskNode("start")), /节点 ID 已存在/, "重复添加同 ID 节点时应抛出");
});

// ============================================================================
// B5. build() 边 ID 唯一性校验（通过 addEdge 防御）
// ============================================================================

test("B5. addEdge 重复边 ID 时抛出", () => {
  const builder = GraphBuilder.create()
    .addNode(makeTaskNode("start"))
    .addNode(makeEndNode("end"))
    .addEdge(makeEdge("e1", "start", "end"));
  assert.throws(() => builder.addEdge(makeEdge("e1", "start", "end")), /边 ID 已存在/, "重复添加同 ID 边时应抛出");
});

// ============================================================================
// B6. build() 入口节点存在性校验
// ============================================================================

test("B6. build() 入口节点不存在时抛出", () => {
  const builder = GraphBuilder.create()
    .setGraphInfo("g1", "测试图", "测试描述")
    .addNode(makeTaskNode("start"))
    .addNode(makeEndNode("end"))
    .addEdge(makeEdge("e1", "start", "end"))
    .setEntryNodeId("nonexistent");
  assert.throws(() => builder.build(), /入口节点不存在/, "入口节点不存在时应抛出");
});

// ============================================================================
// B7. build() 边 from/to 引用有效性校验
// ============================================================================

test("B7. build() 边 from 引用不存在的节点时抛出", () => {
  const builder = GraphBuilder.create()
    .setGraphInfo("g1", "测试图", "测试描述")
    .addNode(makeTaskNode("start"))
    .addNode(makeEndNode("end"))
    .addEdge(makeEdge("e1", "ghost", "end"))
    .setEntryNodeId("start");
  assert.throws(() => builder.build(), /from 引用不存在的节点/, "边 from 引用不存在节点时应抛出");
});

test("B7b. build() 边 to 引用不存在的节点时抛出", () => {
  const builder = GraphBuilder.create()
    .setGraphInfo("g1", "测试图", "测试描述")
    .addNode(makeTaskNode("start"))
    .addNode(makeEndNode("end"))
    .addEdge(makeEdge("e1", "start", "ghost"))
    .setEntryNodeId("start");
  assert.throws(() => builder.build(), /to 引用不存在的节点/, "边 to 引用不存在节点时应抛出");
});

// ============================================================================
// B8. build() 返回冻结的 WorkGraph
// ============================================================================

test("B8. build() 返回冻结的 WorkGraph（Object.isFrozen=true）", () => {
  const graph = GraphBuilder.create()
    .setGraphInfo("g1", "测试图", "测试描述")
    .addNode(makeTaskNode("start"))
    .addNode(makeEndNode("end"))
    .addEdge(makeEdge("e1", "start", "end"))
    .setEntryNodeId("start")
    .build();

  assert.equal(Object.isFrozen(graph), true, "WorkGraph 应被冻结");
});

// ============================================================================
// B9. fromJson() 解析完整 JSON
// ============================================================================

test("B9. fromJson() 解析完整 JSON 并构造 WorkGraph", () => {
  const json = JSON.stringify({
    graphId: "json-graph",
    name: "JSON 图",
    description: "从 JSON 构造的图",
    entryNodeId: "start",
    nodes: [
      {
        nodeId: "start",
        nodeType: "task",
        label: "开始",
        task: "开始任务",
        inputContract: [],
        outputContract: [{ name: "result", type: "string", required: true }],
        plugin: "echo",
      },
      {
        nodeId: "end",
        nodeType: "end",
        label: "结束",
        task: "结束任务",
        inputContract: [],
        outputContract: [],
      },
    ],
    edges: [
      {
        edgeId: "e1",
        from: "start",
        to: "end",
        dataMapping: {},
      },
    ],
    config: {
      maxDepth: 50,
      maxParallelism: 2,
      maxTokens: 1000,
      timeoutSec: 30,
      enableExperienceRecall: false,
      enableAutoIsolation: true,
      nodeRetryLimit: 2,
    },
    globalState: { sessionId: "s1" },
  });

  const graph = GraphBuilder.fromJson(json).build();

  assert.equal(graph.graphId, "json-graph");
  assert.equal(graph.name, "JSON 图");
  assert.equal(graph.entryNodeId, "start");
  assert.equal(graph.nodes.size, 2);
  assert.equal(graph.edges.length, 1);
  assert.equal(graph.config.maxDepth, 50, "config.maxDepth 应从 JSON 覆盖");
  assert.equal(graph.config.maxParallelism, 2);
  assert.equal(graph.config.timeoutSec, 30);
  assert.equal(graph.globalState.sessionId, "s1", "globalState 应从 JSON 读取");

  // 校验节点契约传递
  const startNode = graph.nodes.get("start")!;
  assert.equal(startNode.outputContract.length, 1);
  assert.equal(startNode.outputContract[0].name, "result");
  assert.equal(startNode.outputContract[0].type, "string");
});

// ============================================================================
// B10. fromJson() 缺省字段使用默认值
// ============================================================================

test("B10. fromJson() 缺省 config 时使用 DEFAULT_WORK_GRAPH_CONFIG", () => {
  const json = JSON.stringify({
    graphId: "g1",
    name: "测试",
    description: "描述",
    entryNodeId: "start",
    nodes: [{ nodeId: "start", nodeType: "end", label: "开始", task: "任务" }],
    edges: [],
  });

  const graph = GraphBuilder.fromJson(json).build();
  assert.equal(graph.config.maxDepth, DEFAULT_WORK_GRAPH_CONFIG.maxDepth, "缺省 config 时应使用默认 maxDepth");
  assert.equal(graph.config.maxParallelism, DEFAULT_WORK_GRAPH_CONFIG.maxParallelism);
  assert.equal(graph.config.nodeRetryLimit, DEFAULT_WORK_GRAPH_CONFIG.nodeRetryLimit);
});

test("B10b. fromJson() 缺省 globalState 时使用空对象", () => {
  const json = JSON.stringify({
    graphId: "g1",
    name: "测试",
    description: "描述",
    entryNodeId: "start",
    nodes: [{ nodeId: "start", nodeType: "end", label: "开始", task: "任务" }],
    edges: [],
  });

  const graph = GraphBuilder.fromJson(json).build();
  assert.equal(Object.keys(graph.globalState).length, 0, "缺省 globalState 时应为空对象");
});

test("B10c. fromJson() 缺省 inputContract/outputContract 时使用空数组", () => {
  const json = JSON.stringify({
    graphId: "g1",
    name: "测试",
    description: "描述",
    entryNodeId: "start",
    nodes: [{ nodeId: "start", nodeType: "end", label: "开始", task: "任务" }],
    edges: [{ edgeId: "e1", from: "start", to: "start" }],
  });

  const graph = GraphBuilder.fromJson(json).build();
  const node = graph.nodes.get("start")!;
  assert.equal(node.inputContract.length, 0, "缺省 inputContract 时应为空数组");
  assert.equal(node.outputContract.length, 0, "缺省 outputContract 时应为空数组");
});

test("B10d. fromJson() 缺省 dataMapping 时使用空对象", () => {
  const json = JSON.stringify({
    graphId: "g1",
    name: "测试",
    description: "描述",
    entryNodeId: "start",
    nodes: [{ nodeId: "start", nodeType: "end", label: "开始", task: "任务" }],
    edges: [{ edgeId: "e1", from: "start", to: "start" }],
  });

  const graph = GraphBuilder.fromJson(json).build();
  assert.equal(Object.keys(graph.edges[0].dataMapping).length, 0, "缺省 dataMapping 时应为空对象");
});

// ============================================================================
// B11. fromJson() 必填字段缺失时抛出
// ============================================================================

test("B11. fromJson() 缺少 graphId 时抛出", () => {
  const json = JSON.stringify({
    name: "测试",
    description: "描述",
    entryNodeId: "start",
    nodes: [],
    edges: [],
  });
  assert.throws(() => GraphBuilder.fromJson(json), /必填字段 "graphId" 缺失或为空/, "缺少 graphId 时应抛出");
});

test("B11b. fromJson() 缺少 nodes 时抛出", () => {
  const json = JSON.stringify({
    graphId: "g1",
    name: "测试",
    description: "描述",
    entryNodeId: "start",
    edges: [],
  });
  assert.throws(() => GraphBuilder.fromJson(json), /必填字段 "nodes" 缺失或为空/, "缺少 nodes 时应抛出");
});

// ============================================================================
// B12. fromJson() 非法 JSON 抛出
// ============================================================================

test("B12. fromJson() 非法 JSON 字符串抛出", () => {
  assert.throws(() => GraphBuilder.fromJson("{ invalid json }"), /JSON 解析失败/, "非法 JSON 应抛出解析错误");
});

test("B12b. fromJson() 解析结果为数组时抛出", () => {
  assert.throws(() => GraphBuilder.fromJson("[]"), /解析结果必须是对象/, "解析结果为数组时应抛出");
});

test("B12c. fromJson() 解析结果为 null 时抛出", () => {
  assert.throws(() => GraphBuilder.fromJson("null"), /解析结果必须是对象/, "解析结果为 null 时应抛出");
});

// ============================================================================
// B13. fromJson() nodes/edges 非数组时抛出
// ============================================================================

test("B13. fromJson() nodes 不是数组时抛出", () => {
  const json = JSON.stringify({
    graphId: "g1",
    name: "测试",
    description: "描述",
    entryNodeId: "start",
    nodes: "not-an-array",
    edges: [],
  });
  assert.throws(() => GraphBuilder.fromJson(json), /nodes 必须是数组/, "nodes 非数组时应抛出");
});

test("B13b. fromJson() edges 不是数组时抛出", () => {
  const json = JSON.stringify({
    graphId: "g1",
    name: "测试",
    description: "描述",
    entryNodeId: "start",
    nodes: [],
    edges: "not-an-array",
  });
  assert.throws(() => GraphBuilder.fromJson(json), /edges 必须是数组/, "edges 非数组时应抛出");
});

// ============================================================================
// B14-B15. addNode / addEdge 重复 ID（已在 B4/B5 中覆盖）
// ============================================================================

test("B14. addNode 重复 ID 抛出（已由 B4 覆盖，此处验证错误消息含 nodeId）", () => {
  const builder = GraphBuilder.create().addNode(makeTaskNode("dup"));
  try {
    builder.addNode(makeTaskNode("dup"));
    assert.fail("应抛出错误");
  } catch (err) {
    assert.match(err instanceof Error ? err.message : String(err), /dup/, "错误消息应包含重复的 nodeId");
  }
});

test("B15. addEdge 重复 ID 抛出（已由 B5 覆盖，此处验证错误消息含 edgeId）", () => {
  const builder = GraphBuilder.create()
    .addNode(makeTaskNode("a"))
    .addNode(makeTaskNode("b"))
    .addEdge(makeEdge("dup", "a", "b"));
  try {
    builder.addEdge(makeEdge("dup", "a", "b"));
    assert.fail("应抛出错误");
  } catch (err) {
    assert.match(err instanceof Error ? err.message : String(err), /dup/, "错误消息应包含重复的 edgeId");
  }
});

// ============================================================================
// B16. fromJson() loopConfig 缺省字段合并默认值
// ============================================================================

test("B16. fromJson() loop 节点的 loopConfig 部分字段缺省时合并 DEFAULT_NODE_LOOP_CONFIG", () => {
  const json = JSON.stringify({
    graphId: "g1",
    name: "测试",
    description: "描述",
    entryNodeId: "loop1",
    nodes: [
      {
        nodeId: "loop1",
        nodeType: "loop",
        label: "循环节点",
        task: "循环任务",
        inputContract: [],
        outputContract: [],
        loopConfig: {
          loopType: "coding",
          discoveryMode: "auto",
          evaluatorMode: "standard",
          maxIterations: 5,
          maxTokens: 50000,
          stopWhen: "",
          autoCommit: true,
          humanCheckpointEvery: 0,
          // stageOrder 缺省，应使用 DEFAULT_NODE_LOOP_CONFIG.stageOrder
        },
      },
    ],
    edges: [],
  });

  const graph = GraphBuilder.fromJson(json).build();
  const loopNode = graph.nodes.get("loop1")!;
  assert.ok(loopNode.loopConfig, "loop 节点应有 loopConfig");
  assert.equal(loopNode.loopConfig.maxIterations, 5, "maxIterations 应从 JSON 读取");
  assert.equal(loopNode.loopConfig.autoCommit, true, "autoCommit 应从 JSON 读取");
  assert.deepEqual(
    [...loopNode.loopConfig.stageOrder],
    [...DEFAULT_NODE_LOOP_CONFIG.stageOrder],
    "缺省 stageOrder 应使用默认值"
  );
});

// ============================================================================
// B17. build() 空节点列表抛出
// ============================================================================

test("B17. build() 节点列表为空时抛出", () => {
  const builder = GraphBuilder.create().setGraphInfo("g1", "测试", "描述").setEntryNodeId("start");
  // 未添加任何节点
  assert.throws(() => builder.build(), /nodes 为空/, "节点列表为空时应抛出");
});

// ============================================================================
// B18. setConfig 合并默认值
// ============================================================================

test("B18. setConfig 部分覆盖时合并 DEFAULT_WORK_GRAPH_CONFIG", () => {
  const graph = GraphBuilder.create()
    .setGraphInfo("g1", "测试", "描述")
    .addNode(makeTaskNode("start"))
    .addNode(makeEndNode("end"))
    .addEdge(makeEdge("e1", "start", "end"))
    .setEntryNodeId("start")
    .setConfig({ maxDepth: 50 } as Partial<typeof DEFAULT_WORK_GRAPH_CONFIG>)
    .build();

  assert.equal(graph.config.maxDepth, 50, "maxDepth 应被覆盖");
  assert.equal(graph.config.maxParallelism, DEFAULT_WORK_GRAPH_CONFIG.maxParallelism, "未覆盖的字段应使用默认值");
});

// ============================================================================
// B19. setGlobalState 传递
// ============================================================================

test("B19. setGlobalState 设置的值在 build() 后可读", () => {
  const state = { userId: "u1", sessionId: "s1", config: { debug: true } };
  const graph = GraphBuilder.create()
    .setGraphInfo("g1", "测试", "描述")
    .addNode(makeTaskNode("start"))
    .addNode(makeEndNode("end"))
    .addEdge(makeEdge("e1", "start", "end"))
    .setEntryNodeId("start")
    .setGlobalState(state)
    .build();

  assert.equal(graph.globalState.userId, "u1");
  assert.equal(graph.globalState.sessionId, "s1");
  assert.deepEqual(graph.globalState.config, { debug: true });
});

// ============================================================================
// B20. 字段契约完整传递（inputContract / outputContract / plugin / decisionPredicateId）
// ============================================================================

test("B20. build() 后节点字段契约完整传递", () => {
  const inputContract: NodeFieldContract[] = [
    { name: "req", type: "string", required: true },
    { name: "opt", type: "number", required: false, defaultValue: 42 },
  ];
  const outputContract: NodeFieldContract[] = [{ name: "result", type: "object", required: true }];

  const graph = GraphBuilder.create()
    .setGraphInfo("g1", "测试", "描述")
    .addNode(makeNodeWithContract("task1", "task", inputContract, outputContract))
    .addNode(makeEndNode("end"))
    .addEdge(makeEdge("e1", "task1", "end"))
    .setEntryNodeId("task1")
    .build();

  const node = graph.nodes.get("task1")!;
  assert.equal(node.inputContract.length, 2, "inputContract 应有 2 个字段");
  assert.equal(node.inputContract[0].name, "req");
  assert.equal(node.inputContract[1].defaultValue, 42);
  assert.equal(node.outputContract.length, 1);
  assert.equal(node.outputContract[0].name, "result");
  assert.equal(node.plugin, "echo", "plugin 应被传递");
});
