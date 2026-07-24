/**
 * 图生命周期管理器数据模型（TOP-1）
 *
 * 本模块定义 GraphLifecycleManager 所需的状态机、协议与事件类型，
 * 统一封装 WorkGraph 的初始化、运行、停止、状态查询和重置。
 *
 * 设计目标（对齐设计文档 §13.12 / 附录 D TOP-1）：
 * - 将 GraphLoopOrchestrator 的构造与运行封装到统一生命周期中，避免 CLI 与业务代码直接操作编排器。
 * - 提供显式状态机，使外部调用方（CLI、Web UI、自动化脚本）能够安全地驱动图执行。
 * - 支持状态变更监听器，便于上层接入日志、指标、调试器（如 TOP-5 GraphDebugger）。
 * - 非法状态转换必须显式报错，防止竞态导致不可预期的行为。
 *
 * 状态机说明：
 * - idle：初始状态，尚未初始化或已完成 reset。
 * - initializing：initialize() 已调用，正在构造编排器和校验图。
 * - ready：初始化完成，可以调用 start() 启动图执行。
 * - running：start() 已调用，图正在执行中。
 * - stopping：stop() 已调用，正在等待当前节点执行完成并退出主循环。
 * - completed：图执行正常完成（finalStatus === "completed"）。
 * - failed：图执行失败（finalStatus !== "completed" 或 start() 抛异常）。
 * - resetting：reset() 已调用，正在清理内部状态。
 *
 * 状态转换规则：
 * - idle ──initialize()──> initializing ──构造完成──> ready
 * - ready ──start()──> running ──成功──> completed
 * - running ──start() 异常──> failed
 * - running ──stop()──> stopping ──start() Promise 完成──> completed / failed
 * - completed / failed / ready ──reset()──> resetting ──清理完成──> idle
 * - running / stopping 状态禁止 reset()
 *
 * 不可变优先原则：所有接口字段声明为 readonly，运行期不可修改。
 *
 * @module eag/graph/graph-lifecycle-models
 */

import type {
  /** 工作图定义 */
  WorkGraph,
  /** 图运行报告 */
  GraphRunReport,
} from "./graph-loop-models";
import type {
  /** 编排器构造选项 */
  GraphLoopOrchestratorOptions,
} from "./graph-loop-protocols";

// ============================================================================
// §1 图生命周期状态机
// ============================================================================

/**
 * 图生命周期状态机（TOP-1）
 *
 * 描述 GraphLifecycleManager 内部所处阶段，供调用方查询和监听。
 *
 * 不包含设计中未实现的 pausing / paused 状态，保持精简和可实现。
 */
export type GraphLifecycleState =
  /** 空闲状态：实例刚创建或 reset() 完成后 */
  | "idle"
  /** 初始化中：initialize() 已调用，正在构造编排器和准备图 */
  | "initializing"
  /** 就绪状态：初始化完成，可以调用 start() */
  | "ready"
  /** 运行中：start() 已调用，图遍历主循环正在执行 */
  | "running"
  /** 停止中：stop() 已调用，等待当前执行节点完成后退出主循环 */
  | "stopping"
  /** 已完成：图执行成功结束（finalStatus === "completed"） */
  | "completed"
  /** 已失败：图执行失败结束或 start() 抛异常 */
  | "failed"
  /** 重置中：reset() 已调用，正在清理内部状态 */
  | "resetting";

/**
 * 图生命周期状态机全部合法值（用于运行时枚举与测试断言）
 */
export const GRAPH_LIFECYCLE_STATES: ReadonlyArray<GraphLifecycleState> = Object.freeze([
  "idle",
  "initializing",
  "ready",
  "running",
  "stopping",
  "completed",
  "failed",
  "resetting",
]);

// ============================================================================
// §2 图生命周期事件
// ============================================================================

/**
 * 图生命周期状态变更事件（TOP-1）
 *
 * 当 GraphLifecycleManager 内部状态发生转换时触发，供上层监听器使用。
 * 事件对象本身为不可变快照。
 */
export interface GraphLifecycleStateChangeEvent {
  /** 变更前状态 */
  readonly oldState: GraphLifecycleState;
  /** 变更后状态 */
  readonly newState: GraphLifecycleState;
  /** 状态变更时间戳（ISO 8601 字符串） */
  readonly changedAt: string;
  /**
   * 触发本次状态变更的原因（可选）
   *
   * 例如 stop() 传入的 reason，或 initialize() / start() 等操作的标识。
   */
  readonly reason?: string;
}

/**
 * 图生命周期状态变更监听器签名（TOP-1）
 *
 * @param event 状态变更事件快照
 */
export type GraphLifecycleStateChangeListener = (event: Readonly<GraphLifecycleStateChangeEvent>) => void;

// ============================================================================
// §3 图生命周期管理器协议
// ============================================================================

/**
 * 图生命周期管理器协议（TOP-1）
 *
 * 统一封装 WorkGraph 的完整生命周期，替代调用方直接构造和操作 GraphLoopOrchestrator。
 *
 * 使用示例：
 * ```typescript
 * const manager: GraphLifecycleManagerProtocol = new GraphLifecycleManager();
 * manager.onStateChange = (event) => console.log(`${event.oldState} -> ${event.newState}`);
 *
 * await manager.initialize(graph, options);
 * const report = await manager.start();
 * await manager.reset();
 * ```
 */
export interface GraphLifecycleManagerProtocol {
  /**
   * 初始化图执行环境
   *
   * 调用本方法后，管理器会构造 GraphLoopOrchestrator 实例并校验图定义，
   * 完成后状态从 initializing 迁移到 ready。
   *
   * 幂等性：
   * - 在 idle 或 completed / failed 状态下可重复调用；
   * - 在 ready / running / stopping / resetting 状态下调用视为非法，抛出错误。
   *
   * @param graph 待执行的工作图定义
   * @param options 编排器构造选项（依赖注入，包含 executor / scheduler / guard 等组件）
   * @throws {Error} 当状态不是 idle / completed / failed 时抛出
   */
  initialize(graph: Readonly<WorkGraph>, options: Readonly<GraphLoopOrchestratorOptions>): Promise<void>;

  /**
   * 启动图执行
   *
   * 仅在 ready 状态下可调用。调用后状态迁移到 running，
   * 图遍历完成后根据最终状态迁移到 completed 或 failed。
   *
   * 注意：
   * - 图执行是异步的，返回的 Promise 在图遍历结束后 resolve。
   * - 执行过程中可调用 stop() 请求中止，最终报告中的 finalStatus 会反映为 aborted。
   * - 若编排器 run() 抛异常，本方法将状态设置为 failed 后重新抛出异常。
   *
   * @returns 图运行报告
   * @throws {Error} 当状态不是 ready 时抛出
   */
  start(): Promise<Readonly<GraphRunReport>>;

  /**
   * 请求停止图执行
   *
   * 仅在 running 状态下生效。调用后状态迁移到 stopping，
   * 编排器内部 cancel 信号被设置，当前节点完成后主循环退出。
   *
   * 注意：
   * - 本方法是异步的，但它不等待图执行完全停止；调用方应通过 start() 返回的 Promise 等待结束。
   * - 在非 running 状态下调用本方法为静默空操作（no-op），不抛异常。
   *
   * @param reason 停止原因（可选，用于日志和状态变更事件）
   */
  stop(reason?: string): Promise<void>;

  /**
   * 查询当前生命周期状态
   *
   * @returns 当前状态快照
   */
  status(): GraphLifecycleState;

  /**
   * 重置生命周期管理器
   *
   * 清理 orchestrator、currentGraph、currentReport 等内部状态，完成后回到 idle。
   *
   * 限制：
   * - 在 running 或 stopping 状态下调用会抛出错误，必须先调用 stop() 并等待 start() Promise 完成。
   * - 在 idle 状态下调用为幂等空操作。
   *
   * @throws {Error} 当状态为 running 或 stopping 时抛出
   */
  reset(): Promise<void>;

  /**
   * 状态变更监听器（可选）
   *
   * 每次状态转换时触发，调用方可以注入日志、指标、调试器（TOP-5）等。
   * 注意：监听器执行异常不得中断状态转换流程；实现类应包裹 try-catch 并记录警告。
   */
  onStateChange?: GraphLifecycleStateChangeListener;
}
