/**
 * 图调试器实现（TOP-5 图调试工具与运行时文档）
 *
 * 本模块提供图执行过程的结构化调试事件收集与快照能力：
 * - NoOpDebugger：默认空实现，未启用调试时零开销
 * - DefaultGraphDebugger：真实实现，维护事件环形缓冲区，支持级别过滤、敏感数据脱敏、执行快照
 * - createGraphDebugger：工厂函数，便于调用方按配置快速创建
 *
 * 设计约束：
 * - 与 GraphLogger 独立：GraphLogger 用于业务日志，调试器用于结构化观测
 * - 不可变优先：内部事件对象构造后通过 Object.freeze 冻结；getExecutionSnapshot 返回深拷贝+冻结对象
 * - 安全默认：includeNodeSnapshots 默认 false，敏感字段默认脱敏
 * - 内存安全：maxEvents 默认 1000，FIFO 丢弃旧事件
 * - 跨运行隔离：reset(runId) 清空事件缓冲并切换 runId
 *
 * @module eag/graph/graph-debug
 */

import { randomUUID } from "crypto";
import type {
  /** 图节点定义 */
  GraphNodeDef,
  /** 图节点执行结果 */
  GraphNodeResult,
  /** 图运行上下文 */
  GraphRunContext,
  /** 图级护栏检查结果 */
  GraphGuardCheckResult,
  /** 图调试事件 */
  GraphDebugEvent,
  /** 图调试选项 */
  GraphDebugOptions,
  /** 图执行快照 */
  GraphExecutionSnapshot,
  /** 图调试追踪级别 */
  GraphDebugLogLevel,
} from "./graph-loop-models";
import type { GraphDebuggerProtocol } from "./graph-loop-protocols";
import { deepFreeze, deepClone, redactSensitiveFields } from "./graph-context-utils";

// ============================================================================
// 常量
// ============================================================================

/**
 * 默认事件环形缓冲区上限
 *
 * 取值 1000：足以覆盖大多数中小型图的完整执行轨迹，同时避免长时间运行导致内存泄漏。
 */
const DEFAULT_MAX_EVENTS = 1000;

/**
 * 追踪级别数值映射
 *
 * 用于运行时比较：级别数值越大越详细。
 * off=0 表示完全关闭；trace=3 表示最详细。
 */
const LOG_LEVEL_RANK: Readonly<Record<GraphDebugLogLevel, number>> = Object.freeze({
  off: 0,
  info: 1,
  debug: 2,
  trace: 3,
});

// ============================================================================
// 工具函数
// ============================================================================

/**
 * 生成调试事件唯一标识
 *
 * 使用 crypto 模块生成 UUID v4 格式字符串，无额外依赖。
 * Node.js 18+ 原生支持 crypto.randomUUID。
 *
 * @returns UUID 字符串
 */
function generateDebugEventId(): string {
  return randomUUID();
}

/**
 * 获取当前 ISO 时间戳
 *
 * @returns ISO 8601 格式时间字符串
 */
function generateTimestamp(): string {
  return new Date().toISOString();
}

/**
 * 判断当前配置是否应记录某级别的事件
 *
 * 规则：当前 logLevel 的数值 >= 事件所需级别的数值时才记录。
 * 例如 info 级别会记录 info 及以上事件，但不会记录 debug/trace 事件。
 *
 * @param currentLevel 当前配置的 logLevel
 * @param requiredLevel 事件所需的最低级别
 * @returns true 表示应记录该事件
 */
function shouldLog(currentLevel: GraphDebugLogLevel, requiredLevel: GraphDebugLogLevel): boolean {
  return LOG_LEVEL_RANK[currentLevel] >= LOG_LEVEL_RANK[requiredLevel];
}

/**
 * 构造安全的快照摘要对象
 *
 * 当 includeNodeSnapshots=false 时，不保留原始 input/output/globalState 对象，
 * 仅保留字段名列表、状态、耗时等元信息，避免敏感数据泄漏。
 *
 * @param input 节点输入数据（可能含敏感字段）
 * @returns 摘要对象（只含 keys 和长度信息）
 */
function makeInputSummary(input: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const snapshot = { ...input };
  redactSensitiveFields(snapshot);
  return {
    inputKeys: Object.keys(input),
    inputSize: Object.keys(input).length,
  };
}

/**
 * 字符串值中的敏感信息正则（大小写不敏感）
 *
 * 匹配 api_key / secret / token / password / credential 等敏感字段名后接赋值符号
 * （冒号或等号）和具体值的模式，如 password=secret123、token: abc。
 */
const SENSITIVE_VALUE_PATTERN = /(api[_-]?key|secret|token|password|credential)\s*[:=]\s*\S+/gi;

/**
 * 对字符串值中的敏感信息进行脱敏
 *
 * 仅替换敏感字段赋值部分，保留字段名前缀，便于调试时识别字段类型。
 *
 * @param value 原始字符串
 * @returns 脱敏后的字符串
 */
function redactSensitiveString(value: string): string {
  return value.replace(SENSITIVE_VALUE_PATTERN, "$1=[REDACTED]");
}

/**
 * 构造节点结果的安全摘要
 *
 * 对 output 中的敏感字段脱敏；当 includeNodeSnapshots=false 时仅保留 output 字段名。
 *
 * @param result 节点执行结果
 * @param includeSnapshots 是否包含完整快照
 * @returns 摘要后的结果对象
 */
function makeResultSummary(result: Readonly<GraphNodeResult>, includeSnapshots: boolean): Record<string, unknown> {
  if (includeSnapshots) {
    const outputCopy = deepClone(result.output) as Record<string, unknown>;
    redactSensitiveFields(outputCopy);
    return {
      status: result.status,
      durationSec: result.durationSec,
      retryCount: result.retryCount,
      failureReason: result.failureReason,
      output: outputCopy,
      outputKeys: Object.keys(result.output),
    };
  }
  return {
    status: result.status,
    durationSec: result.durationSec,
    retryCount: result.retryCount,
    failureReason: result.failureReason,
    outputKeys: Object.keys(result.output),
  };
}

/**
 * 对 guard 检查结果构造安全摘要
 *
 * 对 reason 字段进行敏感词脱敏（reason 可能包含路径、token 等信息）。
 *
 * @param guardResult 护栏检查结果
 * @returns 摘要对象
 */
function makeGuardSummary(guardResult: Readonly<GraphGuardCheckResult>): Record<string, unknown> {
  const reason = guardResult.reason ?? "";
  const reasonCopy: Record<string, unknown> = { reason: redactSensitiveString(reason) };
  redactSensitiveFields(reasonCopy);
  return {
    passed: guardResult.passed,
    reason: reasonCopy.reason,
    suggestedAction: guardResult.suggestedAction,
    severity: guardResult.severity,
  };
}

// ============================================================================
// NoOpDebugger：默认空实现
// ============================================================================

/**
 * 空调试器实现
 *
 * 所有方法均为空操作，保证未注入调试器时零开销。
 * GraphLoopOrchestrator 默认使用此实现，避免对现有行为产生任何影响。
 */
export class NoOpDebugger implements GraphDebuggerProtocol {
  /** @inheritdoc */
  configure(_options: Readonly<GraphDebugOptions>): void {
    // 空实现：不保存配置、不生成事件
  }

  /** @inheritdoc */
  reset(_runId: string): void {
    // 空实现：无状态需要清理
  }

  /** @inheritdoc */
  traceNodeStart(
    _node: Readonly<GraphNodeDef>,
    _input: Readonly<Record<string, unknown>>,
    _context: Readonly<GraphRunContext>
  ): void {
    // 空实现
  }

  /** @inheritdoc */
  traceNodeComplete(
    _node: Readonly<GraphNodeDef>,
    _result: Readonly<GraphNodeResult>,
    _context: Readonly<GraphRunContext>
  ): void {
    // 空实现
  }

  /** @inheritdoc */
  traceForkStart(
    _forkNode: Readonly<GraphNodeDef>,
    _branchNodeIds: ReadonlyArray<string>,
    _context: Readonly<GraphRunContext>
  ): void {
    // 空实现
  }

  /** @inheritdoc */
  traceForkComplete(
    _forkNode: Readonly<GraphNodeDef>,
    _branchResults: ReadonlyArray<GraphNodeResult>,
    _context: Readonly<GraphRunContext>
  ): void {
    // 空实现
  }

  /** @inheritdoc */
  traceMerge(
    _mergeNode: Readonly<GraphNodeDef>,
    _upstreamResults: ReadonlyArray<GraphNodeResult>,
    _context: Readonly<GraphRunContext>
  ): void {
    // 空实现
  }

  /** @inheritdoc */
  traceFailure(
    _node: Readonly<GraphNodeDef>,
    _result: Readonly<GraphNodeResult>,
    _context: Readonly<GraphRunContext>
  ): void {
    // 空实现
  }

  /** @inheritdoc */
  traceGuard(
    _node: Readonly<GraphNodeDef> | undefined,
    _guardResult: Readonly<GraphGuardCheckResult>,
    _phase: "pre" | "post" | "validate",
    _context: Readonly<GraphRunContext>
  ): void {
    // 空实现
  }

  /** @inheritdoc */
  getExecutionSnapshot(): GraphExecutionSnapshot {
    return {
      runId: "",
      graphId: "",
      completedNodes: Object.freeze([]),
      failedNodes: Object.freeze([]),
      events: Object.freeze([]),
    };
  }
}

// ============================================================================
// DefaultGraphDebugger：真实调试器实现
// ============================================================================

/**
 * 默认图调试器实现
 *
 * 维护事件环形缓冲区，支持：
 * - 四级追踪级别过滤（off / info / debug / trace）
 * - 节点输入输出快照开关（includeNodeSnapshots）
 * - guard 通过事件过滤（includeGuardPassedEvents）
 * - FIFO 事件滑动窗口（maxEvents）
 * - 敏感字段自动脱敏
 * - 跨运行隔离（reset）
 */
export class DefaultGraphDebugger implements GraphDebuggerProtocol {
  /** 当前调试选项（已合并默认值并冻结） */
  private options: Readonly<Required<GraphDebugOptions>>;
  /** 内部事件环形缓冲区 */
  private events: GraphDebugEvent[];
  /** 当前运行 ID（reset 时设置） */
  private currentRunId: string;
  /** 当前图 ID（reset 或首次事件时设置） */
  private currentGraphId: string;

  /**
   * 构造默认调试器
   *
   * @param initialOptions 初始调试选项（缺省字段使用默认值）
   */
  constructor(initialOptions?: Readonly<GraphDebugOptions>) {
    this.options = this.mergeOptions(initialOptions);
    this.events = [];
    this.currentRunId = "";
    this.currentGraphId = "";
  }

  /**
   * 配置调试器选项
   *
   * 传入的配置会覆盖当前配置中的对应字段，未提供字段保持默认值。
   * 配置对象会被冻结后保存。
   *
   * @param options 新的调试选项
   */
  configure(options: Readonly<GraphDebugOptions>): void {
    this.options = this.mergeOptions(options, this.options);
  }

  /**
   * 重置调试器以开始新的图运行
   *
   * 清空事件缓冲，设置新的 runId 和 graphId。
   *
   * @param runId 新的运行 ID
   */
  reset(runId: string): void {
    this.events = [];
    this.currentRunId = runId;
    this.currentGraphId = "";
  }

  /**
   * 追踪节点开始执行
   *
   * 所需级别：debug（即仅在 debug/trace 级别记录）
   * metadata：input 字段数；trace 级别且 includeNodeSnapshots=true 时保留脱敏后的 input
   *
   * @param node 当前节点定义
   * @param input 节点输入数据
   * @param context 图运行上下文
   */
  traceNodeStart(
    node: Readonly<GraphNodeDef>,
    input: Readonly<Record<string, unknown>>,
    context: Readonly<GraphRunContext>
  ): void {
    if (!shouldLog(this.options.logLevel, "debug")) {
      return;
    }
    this.ensureGraphId(context.graphId);
    const metadata: Record<string, unknown> = makeInputSummary(input);
    if (this.options.logLevel === "trace" && this.options.includeNodeSnapshots) {
      const inputCopy = deepClone(input) as Record<string, unknown>;
      redactSensitiveFields(inputCopy);
      metadata.inputSnapshot = inputCopy;
    }
    this.pushEvent({
      eventId: generateDebugEventId(),
      runId: context.runId,
      timestamp: generateTimestamp(),
      nodeId: node.nodeId,
      phase: "start",
      message: `节点 ${node.nodeId} 开始执行`,
      metadata,
    });
  }

  /**
   * 追踪节点执行完成
   *
   * 所需级别：info（所有非 off 级别都记录）
   * metadata：节点状态、耗时、重试次数；trace 级别且 includeNodeSnapshots=true 时保留脱敏后的 output
   *
   * @param node 当前节点定义
   * @param result 节点执行结果
   * @param context 图运行上下文
   */
  traceNodeComplete(
    node: Readonly<GraphNodeDef>,
    result: Readonly<GraphNodeResult>,
    context: Readonly<GraphRunContext>
  ): void {
    if (!shouldLog(this.options.logLevel, "info")) {
      return;
    }
    this.ensureGraphId(context.graphId);
    const metadata = makeResultSummary(result, this.options.logLevel === "trace" && this.options.includeNodeSnapshots);
    this.pushEvent({
      eventId: generateDebugEventId(),
      runId: context.runId,
      timestamp: generateTimestamp(),
      nodeId: node.nodeId,
      phase: "complete",
      message: `节点 ${node.nodeId} 执行完成，状态=${result.status}`,
      metadata,
    });
  }

  /**
   * 追踪 fork 节点并行派发开始
   *
   * 所需级别：info
   *
   * @param forkNode fork 节点定义
   * @param branchNodeIds 分支节点 ID 列表
   * @param context 图运行上下文
   */
  traceForkStart(
    forkNode: Readonly<GraphNodeDef>,
    branchNodeIds: ReadonlyArray<string>,
    context: Readonly<GraphRunContext>
  ): void {
    if (!shouldLog(this.options.logLevel, "info")) {
      return;
    }
    this.ensureGraphId(context.graphId);
    this.pushEvent({
      eventId: generateDebugEventId(),
      runId: context.runId,
      timestamp: generateTimestamp(),
      nodeId: forkNode.nodeId,
      phase: "fork",
      message: `fork 节点 ${forkNode.nodeId} 并行派发到 ${branchNodeIds.length} 个分支`,
      metadata: { branchNodeIds: [...branchNodeIds] },
    });
  }

  /**
   * 追踪 fork 节点并行派发完成
   *
   * 所需级别：info
   *
   * @param forkNode fork 节点定义
   * @param branchResults 各分支执行结果
   * @param context 图运行上下文
   */
  traceForkComplete(
    forkNode: Readonly<GraphNodeDef>,
    branchResults: ReadonlyArray<GraphNodeResult>,
    context: Readonly<GraphRunContext>
  ): void {
    if (!shouldLog(this.options.logLevel, "info")) {
      return;
    }
    this.ensureGraphId(context.graphId);
    const summary = branchResults.map((r) => ({
      nodeId: r.nodeId,
      status: r.status,
      durationSec: r.durationSec,
    }));
    this.pushEvent({
      eventId: generateDebugEventId(),
      runId: context.runId,
      timestamp: generateTimestamp(),
      nodeId: forkNode.nodeId,
      phase: "fork",
      message: `fork 节点 ${forkNode.nodeId} 的 ${branchResults.length} 个分支执行完成`,
      metadata: { branchResults: summary },
    });
  }

  /**
   * 追踪 merge 节点汇聚上游结果
   *
   * 所需级别：info
   *
   * @param mergeNode merge 节点定义
   * @param upstreamResults 上游节点结果列表
   * @param context 图运行上下文
   */
  traceMerge(
    mergeNode: Readonly<GraphNodeDef>,
    upstreamResults: ReadonlyArray<GraphNodeResult>,
    context: Readonly<GraphRunContext>
  ): void {
    if (!shouldLog(this.options.logLevel, "info")) {
      return;
    }
    this.ensureGraphId(context.graphId);
    const summary = upstreamResults.map((r) => ({
      nodeId: r.nodeId,
      status: r.status,
    }));
    this.pushEvent({
      eventId: generateDebugEventId(),
      runId: context.runId,
      timestamp: generateTimestamp(),
      nodeId: mergeNode.nodeId,
      phase: "merge",
      message: `merge 节点 ${mergeNode.nodeId} 汇聚了 ${upstreamResults.length} 个上游结果`,
      metadata: { upstreamResults: summary },
    });
  }

  /**
   * 追踪节点失败
   *
   * 所需级别：info（失败事件始终关键）
   * 对 failureReason 进行敏感词脱敏。
   *
   * @param node 失败节点定义
   * @param result 节点执行结果（status 必为 failed）
   * @param context 图运行上下文
   */
  traceFailure(
    node: Readonly<GraphNodeDef>,
    result: Readonly<GraphNodeResult>,
    context: Readonly<GraphRunContext>
  ): void {
    if (!shouldLog(this.options.logLevel, "info")) {
      return;
    }
    this.ensureGraphId(context.graphId);
    const failureReason = result.failureReason ?? "未知失败原因";
    const reasonCopy: Record<string, unknown> = { reason: redactSensitiveString(failureReason) };
    redactSensitiveFields(reasonCopy);
    const metadata = makeResultSummary(result, this.options.logLevel === "trace" && this.options.includeNodeSnapshots);
    metadata.failureReason = reasonCopy.reason;
    this.pushEvent({
      eventId: generateDebugEventId(),
      runId: context.runId,
      timestamp: generateTimestamp(),
      nodeId: node.nodeId,
      phase: "failure",
      message: `节点 ${node.nodeId} 执行失败：${reasonCopy.reason}`,
      metadata,
    });
  }

  /**
   * 追踪护栏检查结果
   *
   * 所需级别：
   * - guard 未通过（passed=false）或 severity=warning/fatal：info
   * - guard 通过：默认不记录；若 includeGuardPassedEvents=true 或 logLevel>=debug 则记录
   *
   * @param node 关联节点（validate 阶段可传 undefined）
   * @param guardResult 护栏检查结果
   * @param phase 护栏触发阶段
   * @param context 图运行上下文
   */
  traceGuard(
    node: Readonly<GraphNodeDef> | undefined,
    guardResult: Readonly<GraphGuardCheckResult>,
    phase: "pre" | "post" | "validate",
    context: Readonly<GraphRunContext>
  ): void {
    const isNotable = !guardResult.passed || guardResult.severity === "warning" || guardResult.severity === "fatal";
    if (!isNotable) {
      // 非显著 guard 事件（通过 + info 级别）：仅在显式要求或 debug/trace 级别才记录
      const shouldKeepPassedEvent = this.options.includeGuardPassedEvents || shouldLog(this.options.logLevel, "debug");
      if (!shouldKeepPassedEvent) {
        return;
      }
    }
    // 显著事件（失败 / warning / fatal）或需要记录的通过事件：
    // 仅在当前 logLevel >= info 时记录（off 级别直接丢弃）
    if (!shouldLog(this.options.logLevel, "info")) {
      return;
    }
    this.ensureGraphId(context.graphId);
    const metadata = makeGuardSummary(guardResult);
    const nodeId = node?.nodeId;
    this.pushEvent({
      eventId: generateDebugEventId(),
      runId: context.runId,
      timestamp: generateTimestamp(),
      nodeId,
      phase: "guard",
      message: `护栏检查 ${phase} ${nodeId ? `节点 ${nodeId}` : "图级"}：${guardResult.passed ? "通过" : "未通过"}，${guardResult.reason}`,
      metadata: { ...metadata, phase },
    });
  }

  /**
   * 获取当前执行快照
   *
   * 返回对象经 deepClone 深拷贝后再 deepFreeze 冻结，确保调用方无法修改内部缓冲。
   * completedNodes / failedNodes 基于事件推导，不依赖外部上下文。
   *
   * @returns 不可变的图执行快照
   */
  getExecutionSnapshot(): GraphExecutionSnapshot {
    const eventsCopy = deepClone(this.events);
    deepFreeze(eventsCopy);
    const completedNodes: string[] = [];
    const failedNodes: string[] = [];
    let currentNodeId: string | undefined;
    for (const event of eventsCopy) {
      if (!event.nodeId) {
        continue;
      }
      if (event.phase === "start") {
        currentNodeId = event.nodeId;
      }
      if (event.phase === "complete" && !completedNodes.includes(event.nodeId)) {
        completedNodes.push(event.nodeId);
      }
      if (event.phase === "failure" && !failedNodes.includes(event.nodeId)) {
        failedNodes.push(event.nodeId);
        if (!completedNodes.includes(event.nodeId)) {
          completedNodes.push(event.nodeId);
        }
      }
    }
    const snapshot: GraphExecutionSnapshot = {
      runId: this.currentRunId,
      graphId: this.currentGraphId,
      currentNodeId,
      completedNodes,
      failedNodes,
      events: eventsCopy,
    };
    return deepFreeze(snapshot);
  }

  // ========================================================================
  // 私有辅助方法
  // ========================================================================

  /**
   * 合并调试选项与默认值
   *
   * @param options 传入选项
   * @param base 基础选项（可选，用于 configure 时保留当前值）
   * @returns 合并后的只读选项
   */
  private mergeOptions(
    options?: Readonly<GraphDebugOptions>,
    base?: Readonly<Required<GraphDebugOptions>>
  ): Readonly<Required<GraphDebugOptions>> {
    const merged: Required<GraphDebugOptions> = {
      logLevel: options?.logLevel ?? base?.logLevel ?? "off",
      includeNodeSnapshots: options?.includeNodeSnapshots ?? base?.includeNodeSnapshots ?? false,
      includeGuardPassedEvents: options?.includeGuardPassedEvents ?? base?.includeGuardPassedEvents ?? false,
      maxEvents: options?.maxEvents ?? base?.maxEvents ?? DEFAULT_MAX_EVENTS,
    };
    return Object.freeze(merged);
  }

  /**
   * 确保当前 graphId 已设置
   *
   * reset 时 graphId 为空，首次事件到达时从 context 读取并记录。
   *
   * @param graphId 图 ID
   */
  private ensureGraphId(graphId: string): void {
    if (!this.currentGraphId && graphId) {
      this.currentGraphId = graphId;
    }
  }

  /**
   * 将事件推入环形缓冲区
   *
   * 事件对象构造后立即冻结，保证内部数组中的每个事件不可变。
   * 当事件数超过 maxEvents 时，丢弃最旧的事件（FIFO）。
   *
   * @param event 待入队事件
   */
  private pushEvent(event: GraphDebugEvent): void {
    const frozenEvent = deepFreeze({ ...event }) as GraphDebugEvent;
    this.events.push(frozenEvent);
    if (this.events.length > this.options.maxEvents) {
      this.events.shift();
    }
  }
}

// ============================================================================
// 工厂函数
// ============================================================================

/**
 * 创建图调试器实例
 *
 * 当 options.logLevel="off" 或 options 未提供时，返回 NoOpDebugger 以保证零开销；
 * 否则返回 DefaultGraphDebugger。
 *
 * @param options 调试选项
 * @returns GraphDebuggerProtocol 实例
 */
export function createGraphDebugger(options?: Readonly<GraphDebugOptions>): GraphDebuggerProtocol {
  if (!options || options.logLevel === "off") {
    return new NoOpDebugger();
  }
  return new DefaultGraphDebugger(options);
}
