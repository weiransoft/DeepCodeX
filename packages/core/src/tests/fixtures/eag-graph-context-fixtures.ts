/**
 * EAG-Graph 上下文集成测试共享夹具
 *
 * 用途：
 * - 为 eag-graph-context-*.test.ts 系列拆分文件提供统一的测试数据构造函数
 * - 提取原 eag-graph-context-integration.test.ts 中的节点构造与日志器构造辅助函数
 * - 避免在每个拆分文件中重复定义相同 helper，保证一致性
 *
 * 设计依据：
 * - LOOP-GRAPH-FUSION-DESIGN.md §13.12.3 I1.* / E2.* / D1-D5 / M2.* 测试用例定义
 * - 测试替身命名禁用 Mock 前缀，统一用 Stub / Silent / InMemory
 *
 * @module core/tests/fixtures/eag-graph-context-fixtures
 */

import type {
  /** 工作图节点定义 */
  GraphNodeDef,
  /** 节点字段契约 */
  NodeFieldContract,
  /** 图日志记录器接口 */
  GraphLogger,
} from "../../eag/graph/graph-loop-models";

// ============================================================================
// 节点构造辅助函数（对齐原 eag-graph-context-integration.test.ts 风格）
// ============================================================================

/**
 * 构造一个 task 节点定义
 *
 * @param nodeId 节点 ID
 * @param outputContract 输出契约（可选，默认空数组）
 * @param inputContract 输入契约（可选，默认空数组）
 * @returns task 类型的 GraphNodeDef 实例
 */
export function makeTaskNode(
  nodeId: string,
  outputContract: ReadonlyArray<NodeFieldContract> = [],
  inputContract: ReadonlyArray<NodeFieldContract> = []
): GraphNodeDef {
  return {
    nodeId,
    nodeType: "task",
    label: nodeId,
    task: `${nodeId} 任务`,
    inputContract,
    outputContract,
    plugin: "echo",
  };
}

/**
 * 构造一个 end 节点定义
 *
 * @param nodeId 节点 ID
 * @returns end 类型的 GraphNodeDef 实例
 */
export function makeEndNode(nodeId: string): GraphNodeDef {
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
 * 构造一个 fork 节点定义（并行派发节点）
 *
 * @param nodeId 节点 ID
 * @returns fork 类型的 GraphNodeDef 实例
 */
export function makeForkNode(nodeId: string): GraphNodeDef {
  return {
    nodeId,
    nodeType: "fork",
    label: nodeId,
    task: `${nodeId} 并行派发`,
    inputContract: [],
    outputContract: [],
  };
}

/**
 * 构造一个 merge 节点定义（汇聚节点）
 *
 * @param nodeId 节点 ID
 * @returns merge 类型的 GraphNodeDef 实例
 */
export function makeMergeNode(nodeId: string): GraphNodeDef {
  return {
    nodeId,
    nodeType: "merge",
    label: nodeId,
    task: `${nodeId} 合并`,
    inputContract: [],
    outputContract: [],
  };
}

/**
 * 创建不输出日志的 GraphLogger（测试用，避免噪音）
 *
 * @returns GraphLogger 实例（所有日志方法均为空实现）
 */
export function makeSilentLogger(): GraphLogger {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}
