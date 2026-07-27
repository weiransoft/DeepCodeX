/**
 * EAG-P3 批次 12 C1 测试夹具：long-horizon/plan-blockage-analyzer.ts 共享辅助函数
 *
 * 用途：
 * - 为 eag-blockage-*.test.ts 系列拆分文件提供统一的测试对象构造函数
 * - 保证测试数据真实可用的同时避免在每个测试文件中重复定义
 * - 所有构造函数均使用 Object.freeze 冻结返回值，符合 EAG 不可变数据契约
 *
 * 设计依据：
 * - EAG-P3 批次 12 设计文档 §3 C1 阻塞分析增强
 * - eag/long-horizon/plan-blockage-analyzer.ts 源文件
 * - eag/long-horizon/types.ts C1 新增类型定义
 *
 * @module core/tests/fixtures/eag-blockage-fixtures
 */

import type {
  MultiLoopNode,
  MultiLoopPlan,
  RunState,
  ResourceAccessGraph,
  ResourceAccessRecord,
  GateStatusSnapshot,
} from "../../eag/long-horizon/types";
import type { GateResult } from "../../eag/gate/gate-types";
import type { LogCallback } from "../../eag/long-horizon/types";

/**
 * 创建测试用 MultiLoopNode（默认 status="pending"）
 *
 * @param nodeId 节点 ID
 * @param loopType Loop 类型
 * @param dependencies 依赖节点 ID 列表
 * @returns MultiLoopNode 实例（冻结）
 */
export function makeNode(
  nodeId: string,
  loopType: "design" | "coding" | "testing",
  dependencies: ReadonlyArray<string> = []
): MultiLoopNode {
  return Object.freeze({
    nodeId,
    loopType,
    dependencies: Object.freeze([...dependencies]),
    status: "pending",
    entryArtifact: `docs/eag/${loopType}.md`,
    exitCriteria: `G-${loopType === "design" ? "1" : loopType === "coding" ? "5" : "7"} passed`,
  });
}

/**
 * 创建测试用 MultiLoopPlan
 *
 * @param nodes 节点列表
 * @param overrides 可选字段覆盖
 * @returns MultiLoopPlan 实例（冻结）
 */
export function makePlan(nodes: ReadonlyArray<MultiLoopNode>, overrides?: Partial<MultiLoopPlan>): MultiLoopPlan {
  return Object.freeze({
    planId: "test-plan-001",
    projectRoot: "/tmp/test-project",
    loops: Object.freeze([...nodes]),
    autoTransition: false,
    rollbackOnFailure: true,
    createdAt: "2026-07-19T10:00:00.000Z",
    ...overrides,
  });
}

/**
 * 创建测试用 RunState（最小可用对象）
 *
 * @param overrides 可选字段覆盖
 * @returns RunState 实例（冻结）
 */
export function makeRunState(overrides?: Partial<RunState>): RunState {
  return Object.freeze({
    runId: "test-run-001",
    projectRoot: "/tmp/test-project",
    startedAt: "2026-07-19T10:00:00.000Z",
    updatedAt: "2026-07-19T10:00:00.000Z",
    currentLoop: "design",
    currentIteration: 0,
    completedLoops: Object.freeze([]),
    completedTaskIds: Object.freeze([]),
    pendingDeleteFiles: Object.freeze([]),
    milestones: Object.freeze([]),
    humanInterventions: Object.freeze([]),
    humanInterventionCount: 0,
    totalLlmCallCount: 0,
    totalTokensUsed: 0,
    status: "running",
    checksum: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
    ...overrides,
  });
}

/**
 * 创建测试用 GateResult
 *
 * @param gate 门禁 ID
 * @param passed 是否通过
 * @param severity 严重性
 * @param reason 失败理由
 * @param guidance 引导消息
 * @returns GateResult 实例（冻结）
 */
export function makeGateResult(
  gate: "G-1" | "G-2" | "G-3" | "G-4" | "G-5" | "G-6" | "G-7",
  passed: boolean,
  severity: "blocker" | "major" | "warning",
  reason: string,
  guidance?: string
): GateResult {
  return Object.freeze({
    gate,
    passed,
    severity,
    reason,
    guidance,
  });
}

/**
 * 创建测试用 GateStatusSnapshot
 *
 * @param gateResults 门禁结果列表
 * @returns GateStatusSnapshot 实例（冻结）
 */
export function makeGateStatusSnapshot(gateResults: ReadonlyArray<GateResult>): GateStatusSnapshot {
  return Object.freeze({
    snapshotAt: "2026-07-19T10:00:00.000Z",
    gateResults: Object.freeze([...gateResults]),
  });
}

/**
 * 创建测试用 ResourceAccessRecord
 *
 * @param nodeId 节点 ID
 * @param resourceId 资源 ID
 * @param accessMode 访问模式
 * @param accessDescription 访问描述
 * @returns ResourceAccessRecord 实例（冻结）
 */
export function makeAccess(
  nodeId: string,
  resourceId: string,
  accessMode: "read" | "write" | "read-write",
  accessDescription: string
): ResourceAccessRecord {
  return Object.freeze({
    nodeId,
    resourceId,
    accessMode,
    accessDescription,
  });
}

/**
 * 创建测试用 ResourceAccessGraph
 *
 * @param accesses 资源访问记录列表
 * @returns ResourceAccessGraph 实例（冻结）
 */
export function makeResourceAccessGraph(accesses: ReadonlyArray<ResourceAccessRecord>): ResourceAccessGraph {
  return Object.freeze({
    accesses: Object.freeze([...accesses]),
  });
}

/**
 * 收集日志消息的辅助函数
 *
 * @returns logger 回调与日志条目数组的元组
 */
export function makeLogCollector(): {
  readonly logs: Array<{ readonly message: string; readonly level?: string }>;
  readonly logger: LogCallback;
} {
  const logs: Array<{ readonly message: string; readonly level?: string }> = [];
  const logger: LogCallback = (message: string, level?: "info" | "warn" | "error") => {
    logs.push({ message, level });
  };
  return { logs, logger };
}
